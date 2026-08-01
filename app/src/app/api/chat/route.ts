import { NextResponse, type NextRequest } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';
import { copilotSystemPrompt, patientCopilotSystemPrompt } from '@/lib/copilotPrompt';
import { patientPortal } from '@/lib/workspace.server';
import { getLlmClient, resolveChatModel } from '@/lib/llmClient';
import {
  bookAppointment,
  checkCoverage,
  completeVisit,
  DENIAL_TEXTS,
  fireEvent,
  latestArtifact,
  recentRuns,
  registerPatient,
  statusSnapshot,
  type CopilotEvent,
} from '@/lib/copilot.server';
import {
  describeForAgent,
  describeForPanel,
  readPatientDocument,
  type AttachedImage,
} from '@/lib/documentRedaction.server';
import type { PipelineStepEvent } from '@/lib/pipeline';

export const maxDuration = 300;

/**
 * Back-office copilot: an agentic chat endpoint for clinicians and front-desk
 * staff. Streams NDJSON events ({type:'text'|'tool'|'done'|'error'}) so the
 * UI can render Cursor-style tool steps live. The copilot only ever sees
 * redacted/aggregate data; run_agent drives the real pipeline in-process.
 * Without an LLM key (OPENROUTER_API_KEY or ANTHROPIC_API_KEY) a keyword-router
 * fallback handles the same commands so the demo never blocks.
 *
 * An attached image is read once by the redaction pass before the agent loop
 * starts; only the boxes and the extracted fields go forward, never the image.
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type Emit = (event: Record<string, unknown>) => void;

const IMAGE_MEDIA_TYPES: ReadonlyArray<AttachedImage['mediaType']> = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

// 12 MB of bytes, which base64 inflates by about a third.
const MAX_BASE64_LENGTH = 17 * 1024 * 1024;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_status',
    description:
      'Snapshot of the whole back office: integration modes, appeal win rate, PHI tokens redacted, care gaps closed, run count, and the learned playbook. Call this for "how are we doing", "status", "win rate".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_runs',
    description: 'Recent pipeline runs (redacted summaries): agent, decision, outcome, sources cited, latency.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max runs to return (default 10)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_artifact',
    description:
      'Fetch the redacted artifact (appeal letter, prior-auth packet, outreach script) from the latest run, or a specific run by runId.',
    input_schema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Optional run id (prefix ok)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'register_patient',
    description:
      'Front desk: register a brand-new patient and verify their insurance eligibility (270/271). Creates the medical record and coverage. Requires at least a name and an insurance company.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name, e.g. "Jordan Lee"' },
        birthDate: { type: 'string', description: 'YYYY-MM-DD if given' },
        phone: { type: 'string' },
        payer: { type: 'string', description: 'Insurance company, e.g. Aetna, Blue Shield PPO, Medicare' },
        memberId: { type: 'string', description: 'Insurance member ID if given' },
      },
      required: ['name', 'payer'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_coverage',
    description:
      'Look up a registered patient\'s insurance and run a live 270/271 eligibility check. Call for "what\'s my coverage", "am I insured", "does my plan cover this".',
    input_schema: {
      type: 'object',
      properties: { patientName: { type: 'string' } },
      required: ['patientName'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_appointment',
    description: 'Front desk: book a visit for a registered patient. Compute startIso from the user’s words and today’s date; omit it for tomorrow 10:00.',
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        description: { type: 'string', description: 'e.g. "New patient check-up"' },
        startIso: { type: 'string', description: 'ISO 8601 start time' },
      },
      required: ['patientName'],
      additionalProperties: false,
    },
  },
  {
    name: 'complete_visit',
    description:
      'Front desk checkout: end the patient’s visit. Marks their appointment fulfilled, records the finished encounter (which fires the discharge agent: post-visit outreach + follow-up booking through the full pipeline), and drafts the visit claim. Returns the claim identifier — always tell the user and reuse it for later run_agent calls on their claim.',
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        procedure: { type: 'string', description: 'What the visit was, e.g. "Office visit — annual physical"' },
        amount: { type: 'number', description: 'Billed amount in USD (default 180)' },
      },
      required: ['patientName'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_agent',
    description:
      'Fire a real pipeline event. "deny" simulates a payer denial (wakes the appeal agent), "approve" records the payer approving a claim after appeal (marks the appeal WON and updates the learned playbook), "triage" runs pre-submission gap check on a claim, "discharge" runs post-discharge patient outreach + care-gap closure, "prior-auth" compiles an authorization packet for the pending MRI order.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', enum: ['deny', 'approve', 'triage', 'discharge', 'prior-auth'] },
        claimIdentifier: {
          type: 'string',
          description: 'Claim identifier, e.g. DEMO-CLAIM-1 (default) or DEMO-CLAIM-2',
        },
        denialCode: {
          type: 'string',
          enum: Object.keys(DENIAL_TEXTS),
          description: 'Denial reason for the "deny" event (default CO-197 = no prior auth)',
        },
      },
      required: ['event'],
      additionalProperties: false,
    },
  },
];

const EVENT_LABELS: Record<CopilotEvent, string> = {
  deny: 'simulate payer denial → appeal agent',
  approve: 'record payer approval → playbook learns',
  triage: 'claim triage',
  discharge: 'discharge outreach + care gaps',
  'prior-auth': 'prior-auth packet',
};

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  onPipelineStep?: (event: PipelineStepEvent) => void,
): Promise<{ result: string; refresh: boolean; detail: string }> {
  switch (name) {
    case 'get_status': {
      const snap = await statusSnapshot();
      return { result: JSON.stringify(snap), refresh: false, detail: `${snap.pipelineRuns} runs · win rate ${snap.appeals.winRatePct ?? '—'}%` };
    }
    case 'list_runs': {
      const runs = await recentRuns(typeof input.limit === 'number' ? input.limit : 10);
      return { result: JSON.stringify(runs), refresh: false, detail: `${runs.length} run(s)` };
    }
    case 'get_artifact': {
      const artifact = await latestArtifact(typeof input.runId === 'string' ? input.runId : undefined);
      return {
        result: artifact ? JSON.stringify(artifact) : 'No artifact found yet — run an agent first.',
        refresh: false,
        detail: artifact ? `${artifact.agent}${artifact.denialCode ? ` · ${artifact.denialCode}` : ''}` : 'none found',
      };
    }
    case 'register_patient': {
      const r = await registerPatient({
        name: String(input.name),
        birthDate: typeof input.birthDate === 'string' ? input.birthDate : undefined,
        phone: typeof input.phone === 'string' ? input.phone : undefined,
        payer: String(input.payer),
        memberId: typeof input.memberId === 'string' ? input.memberId : undefined,
      });
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'check_coverage': {
      const r = await checkCoverage(String(input.patientName));
      return { result: r.summary, refresh: false, detail: r.summary };
    }
    case 'book_appointment': {
      const r = await bookAppointment({
        patientName: String(input.patientName),
        description: typeof input.description === 'string' ? input.description : undefined,
        startIso: typeof input.startIso === 'string' ? input.startIso : undefined,
      });
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'complete_visit': {
      const r = await completeVisit(
        {
          patientName: String(input.patientName),
          procedure: typeof input.procedure === 'string' ? input.procedure : undefined,
          amount: typeof input.amount === 'number' ? input.amount : undefined,
        },
        onPipelineStep,
      );
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'run_agent': {
      const event = input.event as CopilotEvent;
      const fired = await fireEvent(
        event,
        {
          claimIdentifier: typeof input.claimIdentifier === 'string' ? input.claimIdentifier : undefined,
          denialCode: typeof input.denialCode === 'string' ? input.denialCode : undefined,
        },
        onPipelineStep,
      );
      return { result: fired.summary, refresh: true, detail: fired.summary };
    }
    default:
      return { result: `Unknown tool ${name}`, refresh: false, detail: 'unknown tool' };
  }
}

// ── Attached document: redaction pass, before anything else ─────────────────

/**
 * Runs the vision pass and streams it as a step the user can watch. Returns
 * the note to append to their turn — empty when the read failed, so the agent
 * loop proceeds knowing nothing rather than guessing at the card.
 */
async function readAttachment(
  client: Anthropic | null,
  model: string,
  image: AttachedImage,
  emit: Emit,
): Promise<string> {
  const step = { type: 'tool', id: 'doc', name: 'read_document', summary: 'redact attached document' };
  emit({ ...step, status: 'running' });

  if (!client) {
    emit({ ...step, status: 'error', detail: 'reading documents needs an LLM key' });
    return '';
  }
  try {
    const reading = await readPatientDocument(client, model, image);
    emit({
      type: 'pipeline',
      toolId: 'doc',
      step: 'redact-document',
      detail: `${reading.boxes.length} identifying region(s) covered`,
      data: {
        boxes: reading.boxes,
        documentType: reading.documentType,
        fields: describeForPanel(reading.fields),
      },
    });
    emit({ ...step, status: 'done', detail: `${reading.documentType} · ${reading.boxes.length} region(s) boxed` });
    return describeForAgent(reading);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[chat] document redaction pass failed:', err);
    emit({ ...step, status: 'error', detail: `could not read the image — ${message}` });
    return '';
  }
}

// ── LLM-driven agent loop ───────────────────────────────────────────────────

async function agentLoop(client: Anthropic, history: ChatMessage[], model: string, emit: Emit): Promise<void> {
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  let stepId = 0;

  for (let turn = 0; turn < 6; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system: copilotSystemPrompt(),
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      emit({ type: 'text', text: 'I can’t help with that request.' });
      return;
    }

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) emit({ type: 'text', text: block.text });
    }

    if (response.stop_reason !== 'tool_use') return;

    messages.push({ role: 'assistant', content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const id = `s${++stepId}`;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const summary =
        block.name === 'run_agent'
          ? EVENT_LABELS[input.event as CopilotEvent] ?? String(input.event)
          : block.name.replace(/_/g, ' ');
      emit({ type: 'tool', id, name: block.name, summary, status: 'running' });
      try {
        const onPipelineStep =
          block.name === 'run_agent' || block.name === 'complete_visit'
            ? (pe: PipelineStepEvent) => emit({ type: 'pipeline', toolId: id, step: pe.step, detail: pe.detail, data: pe.data })
            : undefined;
        const { result, refresh, detail } = await executeTool(block.name, input, onPipelineStep);
        emit({ type: 'tool', id, name: block.name, summary, status: 'done', detail, refresh });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'tool', id, name: block.name, summary, status: 'error', detail: message });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }
  emit({ type: 'text', text: 'Stopping here — that took more steps than expected. Ask me to continue if needed.' });
}

// ── Patient persona (in-phone copilot on /patient) ──────────────────────────

/** Feed lines + first name for the patient persona, from the same portal data the phone renders. */
async function patientContext(patientId?: string): Promise<{ firstName: string; feedLines: string[] }> {
  const { patient, items } = await patientPortal(patientId);
  return {
    firstName: patient?.name.split(' ')[0] ?? 'there',
    feedLines: items.map((i) => `- [${new Date(i.at).toDateString()}] ${i.title}${i.body ? ` — ${i.body}` : ''}`),
  };
}

/** The only staff tools the patient persona may use — self-service registration and booking. */
const PATIENT_TOOLS = TOOLS.filter(
  (t) => t.name === 'register_patient' || t.name === 'book_appointment' || t.name === 'check_coverage',
);

/** Chat loop for the patient: answers from their own feed; can register themselves and book visits. */
async function patientLoop(
  client: Anthropic,
  history: ChatMessage[],
  model: string,
  emit: Emit,
  patientId?: string,
): Promise<void> {
  const { firstName, feedLines } = await patientContext(patientId);
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  let stepId = 0;

  for (let turn = 0; turn < 4; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 1200,
      output_config: { effort: 'low' },
      system: patientCopilotSystemPrompt(firstName, feedLines),
      tools: PATIENT_TOOLS,
      messages,
    });
    if (response.stop_reason === 'refusal') {
      emit({ type: 'text', text: 'I can’t help with that — please call the clinic and they’ll sort you out.' });
      return;
    }
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) emit({ type: 'text', text: block.text });
    }
    if (response.stop_reason !== 'tool_use') return;

    messages.push({ role: 'assistant', content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const id = `p${++stepId}`;
      const summary =
        block.name === 'register_patient'
          ? 'signing you up'
          : block.name === 'check_coverage'
            ? 'checking your insurance'
            : 'booking your visit';
      emit({ type: 'tool', id, name: block.name, summary, status: 'running' });
      try {
        const { result, refresh, detail } = await executeTool(block.name, (block.input ?? {}) as Record<string, unknown>);
        emit({ type: 'tool', id, name: block.name, summary, status: 'done', detail, refresh });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'tool', id, name: block.name, summary, status: 'error', detail: message });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }
}

/** No-LLM fallback for the patient persona: read the feed back in plain words. */
async function patientFallback(emit: Emit, patientId?: string): Promise<void> {
  const { firstName, feedLines } = await patientContext(patientId);
  emit({
    type: 'text',
    text:
      feedLines.length > 0
        ? `Hi ${firstName}! Here’s the latest on your care: ${feedLines.slice(0, 3).map((l) => l.replace(/^- \[[^\]]*\] /, '')).join(' · ')}. Anything else, just call the clinic.`
        : `Hi ${firstName}! Nothing new on your care feed yet. If you have questions, the clinic is a call away.`,
  });
}

// ── Keyword fallback (no API key) ───────────────────────────────────────────

function fmtDur(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 90_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}

async function fallbackChat(history: ChatMessage[], emit: Emit): Promise<void> {
  const text = history[history.length - 1]?.content.toLowerCase() ?? '';
  const claim = /claim[\s-]*2|demo-claim-2/.test(text) ? 'DEMO-CLAIM-2' : 'DEMO-CLAIM-1';
  const code = Object.keys(DENIAL_TEXTS).find((c) => text.includes(c.toLowerCase()));

  const runTool = async (event: CopilotEvent, summary: string) => {
    emit({ type: 'tool', id: 'f1', name: 'run_agent', summary, status: 'running' });
    try {
      const fired = await fireEvent(event, { claimIdentifier: claim, denialCode: code }, (pe) =>
        emit({ type: 'pipeline', toolId: 'f1', step: pe.step, detail: pe.detail, data: pe.data }),
      );
      emit({ type: 'tool', id: 'f1', name: 'run_agent', summary, status: 'done', detail: fired.summary, refresh: true });
      emit({ type: 'text', text: `Done. ${fired.summary}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'tool', id: 'f1', name: 'run_agent', summary, status: 'error', detail: message });
      emit({ type: 'text', text: `That didn't work: ${message}` });
    }
  };

  if (/(approve|approv|overturn|won|paid)/.test(text)) return runTool('approve', EVENT_LABELS.approve);
  if (/(deny|denial|appeal|reject)/.test(text)) return runTool('deny', EVENT_LABELS.deny);
  if (/(discharge|outreach|call the patient|follow[- ]?up|care gap)/.test(text)) return runTool('discharge', EVENT_LABELS.discharge);
  if (/(prior[- ]?auth|authorization|mri)/.test(text)) return runTool('prior-auth', EVENT_LABELS['prior-auth']);
  if (/(triage|submit|scrub|check the claim|clean claim)/.test(text)) return runTool('triage', EVENT_LABELS.triage);

  if (/(status|win rate|how are we|dashboard|summary|numbers|doing)/.test(text)) {
    emit({ type: 'tool', id: 'f1', name: 'get_status', summary: 'get status', status: 'running' });
    const snap = await statusSnapshot();
    emit({ type: 'tool', id: 'f1', name: 'get_status', summary: 'get status', status: 'done', detail: `${snap.pipelineRuns} runs` });
    const pb = snap.playbook
      .map((p) => `${p.denialCode}: ${p.wins}W/${p.losses}L, avg turnaround ${fmtDur(p.avgTurnaroundMs)}`)
      .join('; ');
    emit({
      type: 'text',
      text:
        `Appeal win rate is ${snap.appeals.winRatePct != null ? `${snap.appeals.winRatePct}%` : 'not established yet'} ` +
        `(${snap.appeals.won} won, ${snap.appeals.lost} lost, ${snap.appeals.pending} pending). ` +
        `${snap.careGapsClosed} care gap(s) closed, ${snap.phiTokensRedacted} PHI tokens redacted across ${snap.pipelineRuns} runs. ` +
        (pb ? `Playbook — ${pb}.` : 'No playbook entries yet.'),
    });
    return;
  }

  if (/(letter|artifact|packet|show me)/.test(text)) {
    const artifact = await latestArtifact();
    emit({
      type: 'text',
      text: artifact
        ? `Latest ${artifact.agent} artifact${artifact.denialCode ? ` (${artifact.denialCode})` : ''}:\n\n${artifact.letterRedacted}`
        : 'No artifacts yet — ask me to appeal a denial or run discharge outreach first.',
    });
    return;
  }

  emit({
    type: 'text',
    text:
      'I can run the back office for you. Try: "appeal the denial on claim 1", "the payer approved claim 1", "run discharge outreach", "start the prior auth for the MRI", "triage claim 2", or "what\'s our win rate?"',
  });
}

// ── Route ───────────────────────────────────────────────────────────────────

interface ChatRequest {
  messages?: ChatMessage[];
  model?: string;
  attachment?: { mediaType?: string; base64?: string };
  persona?: string;
  patientId?: string;
}

/** Validate an uploaded image at the boundary; anything malformed is dropped, not trusted. */
function parseAttachment(raw: ChatRequest['attachment']): AttachedImage | null {
  if (!raw || typeof raw.base64 !== 'string' || !raw.base64) return null;
  const mediaType = IMAGE_MEDIA_TYPES.find((type) => type === raw.mediaType);
  if (!mediaType || raw.base64.length > MAX_BASE64_LENGTH) return null;
  return { mediaType, base64: raw.base64 };
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
  }
  const history = (body.messages ?? []).filter((m) => m && typeof m.content === 'string').slice(-20);
  if (history.length === 0) return NextResponse.json({ error: 'messages required' }, { status: 400 });
  const model = resolveChatModel(typeof body.model === 'string' ? body.model : undefined);
  const attachment = parseAttachment(body.attachment);
  const isPatient = body.persona === 'patient';
  const patientId = typeof body.patientId === 'string' ? body.patientId : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit: Emit = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const client = getLlmClient();
        if (attachment) {
          const note = await readAttachment(client, model, attachment, emit);
          const last = history[history.length - 1];
          if (note && last) last.content = `${last.content}\n\n${note}`.trim();
        }
        if (isPatient) {
          if (client) {
            try {
              await patientLoop(client, history, model, emit, patientId);
            } catch (err) {
              console.warn('[chat] patient loop failed — falling back:', err);
              await patientFallback(emit, patientId);
            }
          } else {
            await patientFallback(emit, patientId);
          }
        } else if (client) {
          try {
            await agentLoop(client, history, model, emit);
          } catch (err) {
            console.warn('[chat] LLM loop failed — falling back to keyword router:', err);
            await fallbackChat(history, emit);
          }
        } else {
          await fallbackChat(history, emit);
        }
        emit({ type: 'done' });
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' },
  });
}
