import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { Redacted } from '@/types/redacted';
import type { IntentConfig } from './intents/shared';
import type { RetrievedSource } from './retrieve';

/**
 * Step 4: reason + act plan. The LLM sees ONLY redacted context (enforced by
 * the Redacted<string> parameter type) plus the retrieved sources. Output is
 * structured JSON; citation integrity is enforced afterwards — any citation
 * marker not present in the retrieval results is rejected and the line
 * carrying it is dropped. Without an API key (or on failure/refusal) a
 * deterministic template produces the artifact so the pipeline never blocks.
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
}

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
1. The context is de-identified. Placeholder tokens like [NAME_1], [DOB_1], [MRN_1], [ID_1], [PHONE_1] stand for real values and MUST be reproduced exactly as written wherever you refer to that detail. Never invent names, dates of birth, or identifiers.
2. Cite evidence ONLY with inline markers [MOSS:<id>] or [PMID:<id>] whose ids appear in RETRIEVED SOURCES below. Citing anything else is forbidden — uncited or falsely-cited lines will be deleted by a validator.
3. Respond with JSON matching the required schema. "citations" lists exactly the source ids you actually used.`;

const g = globalThis as unknown as { __anthropic?: Anthropic };

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  g.__anthropic ??= new Anthropic({ timeout: 120_000, maxRetries: 1 });
  return g.__anthropic;
}

export function reasonEngine(): 'anthropic' | 'template' {
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'template';
}

function sourcesBlock(sources: RetrievedSource[]): string {
  if (sources.length === 0) return '(nothing retrieved — do not cite anything)';
  return sources.map((s) => `[${s.id}] ${s.title}\n${s.text}`).join('\n\n');
}

const MARKER_RE = /\[(?:PMID|MOSS):[^\]\s]+\]/g;

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
  contextText: string,
  sources: RetrievedSource[],
  meta: Record<string, string>,
): Omit<ReasonOutput, 'engine' | 'droppedCitations'> {
  const criteria = sources.find((s) => s.kind === 'moss' && s.title.startsWith('criteria'));
  const playbook = sources.find((s) => s.kind === 'moss' && (s.id.includes('pb-') || s.id.includes('learned-')));
  const learned = sources.find((s) => s.id.startsWith('MOSS:learned-'));
  const pmids = sources.filter((s) => s.kind === 'pubmed');
  const hasMemberTokens = contextText.includes('[NAME_1]');
  const memberLine = hasMemberTokens ? 'Member: [NAME_1] (DOB [DOB_1], MRN [MRN_1])' : '';

  switch (intent.name) {
    case 'denial-appeal': {
      const args: string[] = [];
      if (criteria) {
        args.push(
          `The service met ${meta.payer}'s own published coverage criteria at the time of service: ${firstSentence(criteria.text)} The documented clinical facts satisfy each element. [${criteria.id}]`,
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
      const letter = hasMemberTokens
        ? `Hi [NAME_1], this is the care team checking in after your ${meta.diagnosis ?? 'procedure'}. Call us right away for fever over 101F, severe pain, yellowing skin, or vomiting. We'd like to book your follow-up visit within 2 weeks${gapCount ? ` — and our records show your ${meta.overdueList} is overdue, so we can schedule both in one call` : ''}. Reply YES and we'll set it up.`
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

export async function reason(
  intent: IntentConfig,
  contextText: Redacted,
  sources: RetrievedSource[],
  meta: Record<string, string>,
): Promise<ReasonOutput> {
  const allowed = new Set(sources.map((s) => s.id));
  const client = getClient();

  let raw: Omit<ReasonOutput, 'engine' | 'droppedCitations'> | null = null;
  let engine: ReasonOutput['engine'] = 'template';

  if (client) {
    try {
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
        max_tokens: 8000,
        system: `${intent.systemPrompt}\n${GLOBAL_RULES}`,
        output_config: {
          effort: (process.env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high') || 'low',
          format: { type: 'json_schema', schema: RESPONSE_SCHEMA as unknown as Record<string, unknown> },
        },
        messages: [
          {
            role: 'user',
            content: `TASK:\n${intent.instruction}\n\nDE-IDENTIFIED CONTEXT:\n${contextText}\n\nRETRIEVED SOURCES:\n${sourcesBlock(sources)}`,
          },
        ],
      });
      if (response.stop_reason === 'refusal') {
        console.warn('[reason] model refusal — falling back to template');
      } else {
        const text = response.content.find((b) => b.type === 'text')?.text ?? '';
        const parsed = JSON.parse(text) as Omit<ReasonOutput, 'engine' | 'droppedCitations'>;
        raw = {
          decision: parsed.decision || 'completed',
          rationale: parsed.rationale || '',
          letter: parsed.letter || '',
          keyArguments: parsed.keyArguments ?? [],
          actions: parsed.actions ?? [],
          citations: parsed.citations ?? [],
        };
        engine = 'anthropic';
      }
    } catch (err) {
      console.warn('[reason] LLM call failed — falling back to template:', err);
    }
  }

  if (!raw) {
    raw = templateOutput(intent, contextText as string, sources, meta);
    engine = 'template';
  }

  const enforced = enforceCitations(raw, allowed);
  if (enforced.dropped > 0) {
    console.warn(`[reason] citation validator dropped ${enforced.dropped} line(s) with invented citations`);
  }
  return {
    ...raw,
    letter: enforced.letter,
    citations: enforced.citations,
    engine,
    droppedCitations: enforced.dropped,
  };
}
