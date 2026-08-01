import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { AGENT_TOOLS, AgentToolbox } from './agentTools';
import type { IntentConfig } from './intents/shared';
import { getLlmClient, isLlmConfigured, reasonModelId } from './llmClient';
import type { FhirStore } from './medplum.server';
import type { PipelineStepEvent } from './pipeline';
import type { RetrievedSource } from './retrieve';

/**
 * Step 3: reason + act plan, run as a tool-using agent. The model gathers what
 * it needs over a few tool turns (FHIR, Moss, PubMed, run memory, Stedi), then
 * a final call produces the structured artifact.
 *
 * Two rules keep the loop honest and are easy to break by "simplifying" it:
 * gather turns must NOT carry output_config.format (a tool_use turn has no
 * text block, so JSON.parse('') would throw and silently degrade the run to a
 * template letter), and ids the model retrieves mid-run must be added to the
 * citation allowlist before enforcement or the validator deletes those lines.
 *
 * Without an API key (or on failure/refusal) a deterministic template produces
 * the artifact so the pipeline never blocks.
 */

export interface ReasonOutput {
  decision: string;
  rationale: string;
  letter: string;
  keyArguments: string[];
  actions: string[];
  citations: string[];
  engine: 'anthropic' | 'template';
  droppedCitations: number;
  /** Pre-retrieved sources plus everything the agent's own tool calls found. */
  sources: RetrievedSource[];
  toolCalls: number;
}

/** The artifact itself, before the engine, citation, and tool bookkeeping. */
type ArtifactFields = Pick<ReasonOutput, 'decision' | 'rationale' | 'letter' | 'keyArguments' | 'actions' | 'citations'>;

export interface ReasonDeps {
  store: FhirStore;
  /** Label → FHIR reference, so the agent has handles to read and search with. */
  refs: Record<string, string>;
  onStep?: (event: PipelineStepEvent) => void;
}

/** Gather turns are tool calls and short reasoning; the artifact comes later. */
const MAX_GATHER_TURNS = 4;
const GATHER_MAX_TOKENS = 4000;
const ARTIFACT_MAX_TOKENS = 8000;
/** reason() runs inside a chat-route tool call under that route's 300s ceiling. */
const GATHER_BUDGET_MS = 90_000;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string' },
    rationale: { type: 'string' },
    letter: { type: 'string' },
    keyArguments: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'string' } },
    citations: { type: 'array', items: { type: 'string' } },
  },
  required: ['decision', 'rationale', 'letter', 'keyArguments', 'actions', 'citations'],
  additionalProperties: false,
} as const;

const GLOBAL_RULES = `
HARD RULES:
1. Use the member's name, dates, and identifiers exactly as the context gives them. Never invent a name, date of birth, or identifier.
2. Cite evidence ONLY with inline markers [MOSS:<id>], [MEMORY:<id>], or [PMID:<id>] whose ids appear in RETRIEVED SOURCES below, or that one of your own retrieval tool calls (moss_search, pubmed_search, memory_search) returned to you during this run. Citing anything else is forbidden — falsely-cited lines will be deleted by a validator.
2b. A [MEMORY:*] source is what THIS back office actually did on a previous run of a related case. Treat it as institutional experience: reuse an approach recorded as WON, and strengthen or change one recorded as LOST. When a prior run on the same claim already established a fact (e.g. triage flagged a missing authorization), say so explicitly and cite it.
3. When you are asked for the final artifact, respond with JSON matching the required schema, and let "citations" list exactly the source ids you actually used. Until then, use tools and keep your prose short — do not draft the artifact while you are still gathering.`;

const TOOL_RULES = `
TOOLS:
- You can read and write this clinic's datastore directly. Look things up rather than assuming them, and stop calling tools as soon as you have what you need.
- fhir_search accepts only the parameters in its schema. There is no date, text, or sort search — find by reference, status, code, or identifier, then read what you need.
- Writes are additive: create or patch. There is no delete; retract something by patching its status to "entered-in-error", "revoked", or "cancelled".
- Link anything you create back to this case via subject, focus, or basedOn, or nobody will find it again.
- After you finish, the runtime performs the standard dispatch for this run on its own: it books the appointments, files the prior-auth packet DocumentReference with its provenance category, writes the Task and Communication, and transmits the EDI (837 / 275 / 278). Do not duplicate that work — call the EDI tools only for a transmission you specifically intend on top of it.`;

// 'anthropic' means "LLM-backed" (direct or via OpenRouter); 'template' is the no-key fallback.
export function reasonEngine(): 'anthropic' | 'template' {
  return isLlmConfigured() ? 'anthropic' : 'template';
}

function sourcesBlock(sources: RetrievedSource[]): string {
  if (sources.length === 0) return '(nothing retrieved — do not cite anything)';
  return sources.map((s) => `[${s.id}] ${s.title}\n${s.text}`).join('\n\n');
}

const MARKER_RE = /\[(?:PMID|MOSS|MEMORY):[^\]\s]+\]/g;

/**
 * Citation integrity: keep only markers whose source id was actually
 * retrieved; drop any line of the artifact carrying an invented citation.
 */
function enforceCitations(
  parsed: Pick<ReasonOutput, 'letter' | 'rationale' | 'citations'>,
  allowed: Set<string>,
): { letter: string; citations: string[]; dropped: number } {
  let dropped = 0;
  const isValid = (marker: string) => allowed.has(marker.slice(1, -1));
  const cleanLines = parsed.letter.split('\n').filter((line) => {
    const markers = line.match(MARKER_RE) ?? [];
    const bad = markers.some((m) => !isValid(m));
    if (bad) dropped++;
    return !bad;
  });
  const letter = cleanLines.join('\n');
  const used = new Set<string>();
  for (const m of letter.match(MARKER_RE) ?? []) if (isValid(m)) used.add(m.slice(1, -1));
  for (const c of parsed.citations ?? []) if (allowed.has(c)) used.add(c);
  return { letter, citations: [...used], dropped };
}

// ── Deterministic template fallback (per intent) ────────────────────────────

function firstSentence(s: string): string {
  return s.split(/(?<=\.)\s/)[0] ?? s;
}

function templateOutput(
  intent: IntentConfig,
  sources: RetrievedSource[],
  meta: Record<string, string>,
): ArtifactFields {
  const criteria = sources.find((s) => s.kind === 'moss' && s.title.startsWith('criteria'));
  const playbook = sources.find((s) => s.kind === 'moss' && (s.id.includes('pb-') || s.id.includes('learned-')));
  const learned = sources.find((s) => s.id.startsWith('MOSS:learned-'));
  const priorRun = sources.find((s) => s.kind === 'memory');
  const pmids = sources.filter((s) => s.kind === 'pubmed');
  const memberLine = meta.patientName ? `Member: ${meta.patientName}` : '';

  switch (intent.name) {
    case 'denial-appeal': {
      const args: string[] = [];
      if (criteria) {
        args.push(
          `The service met ${meta.payer}'s own published coverage criteria at the time of service: ${firstSentence(criteria.text)} The documented clinical facts satisfy each element. [${criteria.id}]`,
        );
      }
      if (priorRun) {
        args.push(
          `Our own prior handling of this case is on record and supports the appeal: ${priorRun.text} [${priorRun.id}]`,
        );
      }
      if (learned) {
        args.push(
          `This exact denial (${meta.denialCode}) has been overturned before using the arguments in our learned playbook, which we restate here. [${learned.id}]`,
        );
      } else if (playbook) {
        args.push(`Per our denial playbook for ${meta.denialCode}: ${firstSentence(playbook.text)} [${playbook.id}]`);
      }
      for (const ev of pmids.slice(0, 2)) {
        args.push(`Peer-reviewed evidence supports the clinical indication: "${ev.title}" (${ev.text.split(' — ')[0]}). [${ev.id}]`);
      }
      const letter = [
        `RE: Formal appeal of claim denial — ${meta.denialCode}: ${meta.denialLabel}`,
        memberLine,
        `Claim: ${meta.claimIdentifier} · Service: ${meta.procedure} · Billed: ${meta.amount}`,
        '',
        `To the Appeals Department, ${meta.payer}:`,
        '',
        `We formally appeal the denial of the above claim (reason ${meta.denialCode} — ${meta.denialLabel}) and request that it be overturned and reprocessed for the following reasons:`,
        '',
        ...args.map((a, i) => `${i + 1}. ${a}`),
        '',
        'Clinical documentation is attached via EDI 275. If this written appeal is not overturned, we request a peer-to-peer review with a same-specialty reviewer. Please respond within 30 days as required.',
        '',
        'Sincerely,',
        'Appeals Agent — Autonomous Back Office, on behalf of the treating provider',
      ]
        .filter((l) => l !== null)
        .join('\n');
      return {
        decision: 'appeal-drafted',
        rationale: `Template appeal for ${meta.denialCode} built from ${sources.length} retrieved sources${learned ? ', reusing previously winning arguments from the learned playbook' : ''}.`,
        letter,
        keyArguments: args.map((a) => a.replace(MARKER_RE, '').trim()),
        actions: ['send-appeal-275', 'resubmit-837-replacement'],
        citations: [criteria?.id, playbook?.id, learned?.id, ...pmids.slice(0, 2).map((p) => p.id)].filter(
          (x): x is string => Boolean(x),
        ),
      };
    }
    case 'claim-triage': {
      const needsAuth = (criteria?.text ?? '').toLowerCase().includes('prior authorization') && meta.hasAuth !== 'true';
      const gaps = needsAuth
        ? [`Prior authorization required by payer policy but none on file — obtain auth (or attach retro-auth request) before submission. ${criteria ? `[${criteria.id}]` : ''}`]
        : [];
      const letter = [
        `Pre-submission triage — ${meta.procedure} → ${meta.payer}`,
        memberLine,
        '',
        gaps.length
          ? `Gaps found (${gaps.length}):\n${gaps.map((gap, i) => `${i + 1}. ${gap}`).join('\n')}`
          : `No gaps found: claim satisfies retrieved criteria. ${criteria ? `[${criteria.id}]` : ''}`,
        '',
        gaps.length ? 'Action: fixing gaps, then submitting via 837.' : 'Action: submitting clean via 837.',
      ].join('\n');
      return {
        decision: gaps.length ? 'fix-then-submit' : 'submit-clean',
        rationale: gaps.length ? 'Payer criteria require prior authorization; claim had none.' : 'Claim meets criteria.',
        letter,
        keyArguments: gaps.length ? gaps.map((gap) => gap.replace(MARKER_RE, '').trim()) : ['No gaps against payer criteria'],
        actions: ['eligibility-270', 'submit-837'],
        citations: criteria ? [criteria.id] : [],
      };
    }
    case 'discharge-caregap': {
      const protocol = sources.find((s) => s.id.includes('protocol'));
      const gapCount = Number(meta.overdueCount ?? '0');
      const letter = meta.patientName
        ? `Hi ${meta.patientName.split(' ')[0]}, this is the care team checking in after your ${meta.diagnosis ?? 'procedure'}. Call us right away for fever over 101F, severe pain, yellowing skin, or vomiting. We'd like to book your follow-up visit within 2 weeks${gapCount ? ` — and our records show your ${meta.overdueList} is overdue, so we can schedule both in one call` : ''}. Reply YES and we'll set it up.`
        : `Post-discharge outreach planned: red-flag screen, follow-up within 2 weeks${gapCount ? `, close ${gapCount} overdue screening(s)` : ''}.`;
      return {
        decision: 'outreach-planned',
        rationale: `Follow-up per protocol${protocol ? ` [${protocol.id}]` : ''}; ${gapCount} overdue care gap(s) addressed in the same outreach.`,
        letter,
        keyArguments: [
          'Screen for red flags: fever >101F, severe/worsening pain, jaundice, persistent vomiting',
          'Book surgical follow-up within 7-14 days',
          ...(gapCount ? [`Close overdue screening: ${meta.overdueList}`] : []),
        ],
        actions: ['book-follow-up', ...(gapCount ? ['close-care-gaps'] : []), 'record-outreach-message'],
        citations: protocol ? [protocol.id] : [],
      };
    }
    case 'prior-auth-docs': {
      const letter = [
        `Prior-authorization request packet — ${meta.procedure}`,
        memberLine,
        `Payer: ${meta.payer}`,
        '',
        'Enclosed documentation mapped to your published criteria:',
        `1. Documented clinical indication and ICD-10 diagnosis (ordering note attached). ${criteria ? `[${criteria.id}]` : ''}`,
        '2. Conservative therapy history and outcomes (progress notes attached).',
        '3. Treating-physician order and referral.',
        '',
        'We request authorization determination within the standard review window.',
      ].join('\n');
      return {
        decision: 'docs-compiled',
        rationale: `Packet compiled against ${meta.payer} criteria${criteria ? ` [${criteria.id}]` : ''}.`,
        letter,
        keyArguments: ['Clinical indication documented', 'Conservative therapy documented', 'Physician order attached'],
        actions: ['create-document', 'submit-278'],
        citations: criteria ? [criteria.id] : [],
      };
    }
  }
}

// ── Main entry ──────────────────────────────────────────────────────────────

/** OpenRouter can answer 200 with a provider error in place of a message. */
function providerError(response: unknown): string | undefined {
  return (response as { error?: { message?: string } }).error?.message;
}

interface GatherResult {
  messages: Anthropic.MessageParam[];
  toolCalls: number;
  turns: number;
  refused: boolean;
}

/**
 * Tool-gathering turns. No output_config.format here — see the module header.
 */
async function gatherWithTools(
  client: Anthropic,
  system: string,
  firstMessage: Anthropic.MessageParam,
  toolbox: AgentToolbox,
  effort: 'low' | 'medium' | 'high',
  emit: (step: string, detail: string, data?: Record<string, unknown>) => void,
): Promise<GatherResult> {
  const messages: Anthropic.MessageParam[] = [firstMessage];
  const deadline = Date.now() + GATHER_BUDGET_MS;
  let toolCalls = 0;
  let turns = 0;

  for (let turn = 0; turn < MAX_GATHER_TURNS; turn++) {
    if (Date.now() > deadline) {
      console.warn('[reason] gather budget spent — going to the artifact with what we have');
      break;
    }
    turns++;
    const response = await client.messages.create({
      model: reasonModelId(),
      max_tokens: GATHER_MAX_TOKENS,
      system,
      output_config: { effort },
      tools: AGENT_TOOLS,
      messages,
    });

    if (!Array.isArray(response.content)) {
      console.warn(`[reason] gather turn returned no content: ${providerError(response) ?? 'unknown provider error'}`);
      break;
    }
    if (response.stop_reason === 'refusal') {
      console.warn('[reason] model refusal during gather — falling back to template');
      return { messages, toolCalls, turns, refused: true };
    }

    // Pushed unconditionally, unlike the copilot's loop which returns here:
    // the model's final reasoning turn has to be in the transcript for the
    // artifact call that follows.
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      toolCalls++;
      const input = (block.input ?? {}) as Record<string, unknown>;
      try {
        const { content, detail } = await toolbox.execute(block.name, input);
        emit(`agent-tool → ${block.name}`, detail, sourceData(block.name, toolbox));
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(`agent-tool → ${block.name}`, `failed — ${message}`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { messages, toolCalls, turns, refused: false };
}

/** Retrieval tools surface their hits as trace chips; the rest have nothing to show. */
function sourceData(toolName: string, toolbox: AgentToolbox): Record<string, unknown> | undefined {
  if (!['moss_search', 'pubmed_search', 'memory_search'].includes(toolName)) return undefined;
  return {
    sources: toolbox.discoveredSources.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      snippet: s.text.slice(0, 220),
    })),
  };
}

const FINAL_INSTRUCTION =
  'You now have everything you need. Produce the final artifact as JSON matching the required schema. Cite only ids that appeared in RETRIEVED SOURCES or that your own retrieval tool calls returned during this run.';

/** Roles must alternate, so a trailing tool_result turn absorbs the instruction. */
function appendFinalInstruction(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content)) {
    return [...messages.slice(0, -1), { role: 'user', content: [...last.content, { type: 'text', text: FINAL_INSTRUCTION }] }];
  }
  return [...messages, { role: 'user', content: FINAL_INSTRUCTION }];
}

function buildUserMessage(
  intent: IntentConfig,
  contextText: string,
  sources: RetrievedSource[],
  refs: Record<string, string>,
): Anthropic.MessageParam {
  const handles = Object.entries(refs)
    .map(([label, reference]) => `- ${label}: ${reference}`)
    .join('\n');
  return {
    role: 'user',
    content: [
      `TASK:\n${intent.instruction}`,
      handles ? `RESOURCE HANDLES (use these with fhir_read / fhir_search):\n${handles}` : '',
      `CONTEXT:\n${contextText}`,
      `RETRIEVED SOURCES:\n${sourcesBlock(sources)}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

export async function reason(
  intent: IntentConfig,
  contextText: string,
  sources: RetrievedSource[],
  meta: Record<string, string>,
  deps: ReasonDeps,
): Promise<ReasonOutput> {
  const client = getLlmClient();
  const toolbox = new AgentToolbox(deps.store);
  const emit = (step: string, detail: string, data?: Record<string, unknown>) => deps.onStep?.({ step, detail, data });

  let raw: ArtifactFields | null = null;
  let engine: ReasonOutput['engine'] = 'template';
  let toolCalls = 0;

  if (client) {
    try {
      const effort = (process.env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high') || 'low';
      const system = `${intent.systemPrompt}\n${GLOBAL_RULES}\n${TOOL_RULES}`;
      const gathered = await gatherWithTools(
        client,
        system,
        buildUserMessage(intent, contextText, sources, deps.refs),
        toolbox,
        effort,
        emit,
      );
      toolCalls = gathered.toolCalls;
      if (gathered.refused) throw new Error('model refused during gather');

      const newSources = toolbox.discoveredSources.filter((s) => !sources.some((p) => p.id === s.id));
      emit(
        'agent-tools',
        `${gathered.toolCalls} call(s) over ${gathered.turns} turn(s), ${newSources.length} new source(s)`,
        { toolCalls: gathered.toolCalls, turns: gathered.turns },
      );

      // No `tools` on this call: a tool_use turn carries no text block, so
      // JSON.parse would throw and the run would degrade to the template.
      const response = await client.messages.create({
        model: reasonModelId(),
        max_tokens: ARTIFACT_MAX_TOKENS,
        system,
        output_config: {
          effort,
          format: { type: 'json_schema', schema: RESPONSE_SCHEMA as unknown as Record<string, unknown> },
        },
        messages: appendFinalInstruction(gathered.messages),
      });

      if (!Array.isArray(response.content)) {
        throw new Error(`artifact call returned no content: ${providerError(response) ?? 'unknown provider error'}`);
      }
      if (response.stop_reason === 'refusal') throw new Error('model refused on the artifact call');
      const text = response.content.find((b) => b.type === 'text')?.text ?? '';
      if (!text.trim()) throw new Error('artifact call returned no text block');

      const parsed = JSON.parse(text) as ArtifactFields;
      raw = {
        decision: parsed.decision || 'completed',
        rationale: parsed.rationale || '',
        letter: parsed.letter || '',
        keyArguments: parsed.keyArguments ?? [],
        actions: parsed.actions ?? [],
        citations: parsed.citations ?? [],
      };
      engine = 'anthropic';
    } catch (err) {
      console.warn('[reason] LLM path failed — falling back to template:', err);
    }
  }

  if (!raw) {
    raw = templateOutput(intent, sources, meta);
    engine = 'template';
  }

  // What the agent retrieved mid-run is citable too, but only on the LLM path:
  // templateOutput only ever knows the pre-retrieved ids.
  const byId = new Map(sources.map((s) => [s.id, s]));
  for (const s of toolbox.discoveredSources) if (!byId.has(s.id)) byId.set(s.id, s);
  const finalSources = engine === 'anthropic' ? [...byId.values()] : sources;

  const enforced = enforceCitations(raw, new Set(finalSources.map((s) => s.id)));
  if (enforced.dropped > 0) {
    console.warn(`[reason] citation validator dropped ${enforced.dropped} line(s) with invented citations`);
  }
  return {
    ...raw,
    letter: enforced.letter,
    citations: enforced.citations,
    engine,
    droppedCitations: enforced.dropped,
    sources: finalSources,
    toolCalls,
  };
}
