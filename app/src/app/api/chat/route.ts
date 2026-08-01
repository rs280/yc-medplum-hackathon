import { NextResponse, type NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import {
  bookAppointment,
  completeVisit,
  DENIAL_TEXTS,
  fireEvent,
  latestArtifact,
  recentRuns,
  registerPatient,
  statusSnapshot,
  type CopilotEvent,
} from '@/lib/copilot.server';
import type { PipelineStepEvent } from '@/lib/pipeline';

export const maxDuration = 300;

/**
 * Back-office copilot: an agentic chat endpoint for clinicians and front-desk
 * staff. Streams NDJSON events ({type:'text'|'tool'|'done'|'error'}) so the
 * UI can render Cursor-style tool steps live. The copilot only ever sees
 * redacted/aggregate data; run_agent drives the real pipeline in-process.
 * Without an ANTHROPIC_API_KEY a keyword-router fallback handles the same
 * commands so the demo never blocks.
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type Emit = (event: Record<string, unknown>) => void;

// Function (not const) so "today" is computed per request, not at module load.
const buildSystem = () => `You are the Back-Office Copilot for a medical clinic, embedded next to the operations dashboard. Your users are clinicians and front-desk staff, often speaking by voice, so answer in short plain sentences — no markdown headers, no tables, no bullet walls. Lead with the outcome.

You sit on top of four autonomous FHIR-triggered agents that share one pipeline (redact PHI → retrieve payer criteria via Moss + PubMed evidence → reason → de-redact → act → learn):
- claim triage: pre-submission gap check ("triage" event)
- denial appeal: drafts and submits appeals when a claim is denied ("deny" simulates the payer denial that wakes it; "approve" records the payer overturning it, which teaches the playbook)
- discharge + care-gap outreach: post-discharge patient call that also closes overdue screenings ("discharge")
- prior-auth docs: compiles authorization packets ("prior-auth")

You are ALSO the front desk. You can register brand-new patients, book visits, and check patients out:
- Someone says they're a new patient → collect name + insurance company (birth date, phone, member ID nice to have, don't nag), then call register_patient. Report the eligibility result in plain words.
- "Book me a check-up" → book_appointment. Compute startIso from their words and today's date (below); default tomorrow 10:00 if vague.
- Visit over ("check me out", "I just finished my visit") → complete_visit. This fires the real discharge pipeline (post-visit outreach, follow-up booking) AND drafts the visit claim — ALWAYS state the claim identifier it returns, and remember it: when they later say "insurance denied my claim" or "triage my claim", pass that identifier to run_agent via claimIdentifier.
Never assume someone isn't registered — the store is shared across conversations, so just call the tool with their name; it will say if they're unknown.

Pipeline data is de-identified — placeholder tokens like [NAME_1] stand for real values; never guess at real patient identity. When asked to act on the revenue cycle (appeal, approve, outreach, prior auth, triage), call run_agent. For "how are we doing", get_status / list_runs. get_artifact shows letters. After acting, confirm with concrete numbers. Seeded demo claims: DEMO-CLAIM-1, DEMO-CLAIM-2. Keep replies under ~80 words unless reading an artifact.

Today is ${new Date().toString()}.`;

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

// ── LLM-driven agent loop ───────────────────────────────────────────────────

const g = globalThis as unknown as { __copilotClient?: Anthropic };

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  g.__copilotClient ??= new Anthropic({ timeout: 120_000, maxRetries: 1 });
  return g.__copilotClient;
}

async function agentLoop(client: Anthropic, history: ChatMessage[], emit: Emit): Promise<void> {
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  let stepId = 0;

  for (let turn = 0; turn < 6; turn++) {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_CHAT_MODEL || 'claude-opus-4-8',
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system: buildSystem(),
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

export async function POST(req: NextRequest): Promise<Response> {
  let body: { messages?: ChatMessage[] };
  try {
    body = (await req.json()) as { messages?: ChatMessage[] };
  } catch {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
  }
  const history = (body.messages ?? []).filter((m) => m && typeof m.content === 'string').slice(-20);
  if (history.length === 0) return NextResponse.json({ error: 'messages required' }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit: Emit = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const client = getClient();
        if (client) {
          try {
            await agentLoop(client, history, emit);
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
