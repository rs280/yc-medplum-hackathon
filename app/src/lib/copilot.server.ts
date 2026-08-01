import 'server-only';
import type { Claim, ClaimResponse, Coverage, Encounter, Patient, ServiceRequest } from '@medplum/fhirtypes';
import { getStore, type FhirStore } from './medplum.server';
import { listEpisodic } from './memory/episodic';
import { avgTurnaroundMs, loadPlaybook } from './memory/playbook';
import { mossMode } from './moss.server';
import { runPipeline, type PipelineResult, type PipelineStepEvent } from './pipeline';
import { reasonEngine } from './reason';

/**
 * Copilot actions: everything the side-panel assistant can DO. Mirrors the
 * demo CLI (scripts/demo.ts) but runs in-process — creates the same FHIR
 * resources and pushes them straight through runPipeline, so the copilot and
 * the webhook exercise the identical code path (Task-by-focus dedupes both).
 */

const IDS = 'https://autonomous-backoffice.dev/demo';
const CARC = 'https://x12.org/codes/claim-adjustment-reason-codes';

export const DENIAL_TEXTS: Record<string, string> = {
  'CO-197': 'Precertification/authorization/notification absent.',
  'CO-50': 'These are non-covered services because this is not deemed a medical necessity by the payer.',
  'CO-16': 'Claim/service lacks information or has submission/billing error(s).',
  'CO-29': 'The time limit for filing has expired.',
  'CO-11': 'The diagnosis is inconsistent with the procedure.',
};

export type CopilotEvent = 'deny' | 'approve' | 'triage' | 'discharge' | 'prior-auth';

export interface FireResult {
  summary: string;
  pipeline?: PipelineResult;
}

async function findByIdentifier<T extends Claim | Encounter | Patient | ServiceRequest>(
  store: FhirStore,
  type: T['resourceType'],
  value: string,
): Promise<T> {
  const found = (await store.search<T>(type, { identifier: value }))[0];
  if (!found) throw new Error(`${type} '${value}' not found — run \`npm run seed\` first`);
  return found;
}

async function payerFor(store: FhirStore, patientRef?: string): Promise<string> {
  if (!patientRef) return 'Blue Shield PPO';
  const coverage = (await store.search<Coverage>('Coverage', { beneficiary: patientRef }))[0];
  return coverage?.payor?.[0]?.display ?? 'Blue Shield PPO';
}

export async function fireEvent(
  event: CopilotEvent,
  opts: { claimIdentifier?: string; denialCode?: string } = {},
  onStep?: (event: PipelineStepEvent) => void,
): Promise<FireResult> {
  const store = await getStore();
  const claimId = opts.claimIdentifier || 'DEMO-CLAIM-1';

  switch (event) {
    case 'deny': {
      const code = opts.denialCode && DENIAL_TEXTS[opts.denialCode] ? opts.denialCode : 'CO-197';
      const text = DENIAL_TEXTS[code];
      const claim = await findByIdentifier<Claim>(store, 'Claim', claimId);
      const payer = await payerFor(store, claim.patient?.reference);
      const cr = await store.create<ClaimResponse>({
        resourceType: 'ClaimResponse',
        status: 'active',
        type: claim.type ?? { coding: [{ code: 'professional' }] },
        use: 'claim',
        patient: claim.patient!,
        created: new Date().toISOString(),
        insurer: { display: payer },
        request: { reference: `Claim/${claim.id}` },
        outcome: 'error',
        disposition: `Denied: ${text}`,
        error: [{ code: { coding: [{ system: CARC, code, display: text }] } }],
        item: [
          {
            itemSequence: 1,
            adjudication: [
              {
                category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication', code: 'benefit' }] },
                amount: { value: 0, currency: 'USD' },
              },
            ],
          },
        ],
        processNote: [{ number: 1, text: `Denied: ${text}` }],
      });
      const pipeline = await runPipeline(cr, onStep);
      return { summary: `Denial ${code} recorded on ${claimId} → pipeline ${pipeline.status}: ${pipeline.detail ?? ''}`, pipeline };
    }
    case 'approve': {
      const claim = await findByIdentifier<Claim>(store, 'Claim', claimId);
      const payer = await payerFor(store, claim.patient?.reference);
      const amount = claim.total?.value ?? 0;
      const cr = await store.create<ClaimResponse>({
        resourceType: 'ClaimResponse',
        status: 'active',
        type: claim.type ?? { coding: [{ code: 'professional' }] },
        use: 'claim',
        patient: claim.patient!,
        created: new Date().toISOString(),
        insurer: { display: payer },
        request: { reference: `Claim/${claim.id}` },
        outcome: 'complete',
        disposition: 'Approved on appeal — claim reprocessed and payment issued.',
        payment: { type: { coding: [{ code: 'complete' }] }, amount: { value: amount, currency: 'USD' } },
        item: [
          {
            itemSequence: 1,
            adjudication: [
              {
                category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication', code: 'benefit' }] },
                amount: { value: amount, currency: 'USD' },
              },
            ],
          },
        ],
        processNote: [{ number: 1, text: 'Appeal reviewed; denial overturned; payment issued.' }],
      });
      const pipeline = await runPipeline(cr, onStep);
      return { summary: `Approval recorded on ${claimId} ($${amount}) → ${pipeline.status}: ${pipeline.detail ?? ''}`, pipeline };
    }
    case 'triage': {
      const claim = await findByIdentifier<Claim>(store, 'Claim', claimId);
      const updated = await store.update<Claim>({ ...claim, status: 'active' });
      const pipeline = await runPipeline(updated, onStep);
      return { summary: `Claim ${claimId} set active → triage ${pipeline.status}: ${pipeline.detail ?? ''}`, pipeline };
    }
    case 'discharge': {
      const enc = await findByIdentifier<Encounter>(store, 'Encounter', 'DEMO-ENC-1');
      const updated = await store.update<Encounter>({
        ...enc,
        status: 'finished',
        period: { ...enc.period, end: new Date().toISOString() },
      });
      const pipeline = await runPipeline(updated, onStep);
      return { summary: `Encounter DEMO-ENC-1 finished → discharge outreach ${pipeline.status}: ${pipeline.detail ?? ''}`, pipeline };
    }
    case 'prior-auth': {
      const patient = await findByIdentifier<Patient>(store, 'Patient', 'MRN-001234');
      const existing = (await store.search<ServiceRequest>('ServiceRequest', { identifier: 'DEMO-SR-AUTH' }))[0];
      const sr =
        existing ??
        (await store.create<ServiceRequest>({
          resourceType: 'ServiceRequest',
          identifier: [{ system: IDS, value: 'DEMO-SR-AUTH' }],
          status: 'active',
          intent: 'order',
          subject: { reference: `Patient/${patient.id}` },
          code: {
            coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '72148', display: 'MRI lumbar spine without contrast' }],
            text: 'MRI lumbar spine',
          },
          authoredOn: new Date().toISOString(),
          note: [{ text: 'Progressive radicular symptoms with new motor weakness after 7 weeks of failed conservative therapy (PT + NSAIDs).' }],
        }));
      const pipeline = await runPipeline(sr, onStep);
      return { summary: `MRI lumbar prior-auth request → ${pipeline.status}: ${pipeline.detail ?? ''}`, pipeline };
    }
  }
}

/** Aggregate, PHI-free snapshot of the whole back office for the copilot. */
export async function statusSnapshot() {
  const store = await getStore();
  const [episodic, playbook] = await Promise.all([listEpisodic(store), loadPlaybook(store)]);
  const appeals = episodic.filter((e) => e.intent === 'denial-appeal');
  const won = appeals.filter((e) => e.outcome === 'won').length;
  const lost = appeals.filter((e) => e.outcome === 'lost').length;
  const resolved = won + lost;
  return {
    integrations: {
      medplum: store.mode === 'medplum' ? 'live' : 'demo store',
      moss: mossMode() === 'moss' ? 'live' : 'lexical fallback',
      reasoning: reasonEngine() === 'anthropic' ? 'claude' : 'template',
      stedi: process.env.STEDI_API_KEY ? 'live' : 'simulated',
    },
    appeals: {
      total: appeals.length,
      won,
      lost,
      pending: appeals.filter((e) => e.outcome === 'pending').length,
      winRatePct: resolved > 0 ? Math.round((100 * won) / resolved) : null,
    },
    phiTokensRedacted: episodic.reduce((s, e) => s + e.redactionCount, 0),
    careGapsClosed: episodic.reduce((s, e) => s + (e.gapsClosed ?? 0), 0),
    pipelineRuns: episodic.length,
    playbook: playbook.map((p) => ({
      denialCode: p.denialCode,
      label: p.label,
      wins: p.wins,
      losses: p.losses,
      attempts: p.attempts,
      avgTurnaroundMs: avgTurnaroundMs(p),
      winningPmids: p.winningPmids,
    })),
  };
}

/** Recent pipeline runs (redacted summaries only). */
export async function recentRuns(limit = 10) {
  const store = await getStore();
  const episodic = await listEpisodic(store);
  return episodic.slice(0, limit).map((e) => ({
    runId: e.runId,
    at: e.createdAt,
    agent: e.intent,
    decision: e.decision,
    outcome: e.outcome,
    denialCode: e.denialCode,
    sources: e.retrievedSourceIds,
    redactedTokens: e.redactionCount,
    latencyMs: e.latencyMs,
    engine: e.engine,
    rationale: e.rationale,
  }));
}

/** Latest redacted artifact (letter/packet/script) — tokens visible, no PHI. */
export async function latestArtifact(runId?: string) {
  const store = await getStore();
  const episodic = await listEpisodic(store);
  const match = runId
    ? episodic.find((e) => e.runId === runId || e.runId.startsWith(runId))
    : episodic.find((e) => e.letterRedacted);
  if (!match?.letterRedacted) return null;
  return {
    runId: match.runId,
    agent: match.intent,
    denialCode: match.denialCode,
    outcome: match.outcome,
    letterRedacted: match.letterRedacted,
    keyArguments: match.keyArguments,
  };
}
