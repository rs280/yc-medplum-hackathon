import 'server-only';
import type { Claim, ClaimResponse, Coverage, Encounter, Patient, ServiceRequest } from '@medplum/fhirtypes';
import { getStore, writeAudit, type FhirStore } from './medplum.server';
import { coverageFor } from './intents/shared';
import { fulfilNextBooked } from './appointments.server';
import { findPatientByName, patientDisplayName } from './patients.server';
import { checkEligibility } from './stedi.server';
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

// ── Front-desk actions (AI intake → booking → checkout) ─────────────────────

function shortId(): string {
  return Date.now().toString(36).toUpperCase().slice(-6);
}

/**
 * AI intake: the copilot collects name/DOB/insurance conversationally, then
 * calls this — creates the Patient + Coverage and verifies eligibility via
 * the Stedi 270/271 path, exactly like a front-desk registration.
 */
export async function registerPatient(opts: {
  name: string;
  birthDate?: string;
  phone?: string;
  payer: string;
  memberId?: string;
}): Promise<{ summary: string; mrn: string }> {
  const store = await getStore();
  const existing = await findPatientByName(store, opts.name);
  if (existing) {
    const mrn = existing.identifier?.[0]?.value ?? existing.id!;
    return { summary: `${patientDisplayName(existing)} is already registered (MRN ${mrn}).`, mrn };
  }

  const parts = opts.name.trim().split(/\s+/);
  const family = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const given = parts.length > 1 ? parts.slice(0, -1) : parts;
  const mrn = `MRN-NEW-${shortId()}`;

  const patient = await store.create<Patient>({
    resourceType: 'Patient',
    identifier: [{ system: IDS, value: mrn }],
    name: [{ given, family }],
    birthDate: opts.birthDate,
    telecom: opts.phone ? [{ system: 'phone', value: opts.phone, use: 'mobile' }] : undefined,
  });
  await store.create<Coverage>({
    resourceType: 'Coverage',
    identifier: [{ system: IDS, value: `COV-${mrn}` }],
    status: 'active',
    beneficiary: { reference: `Patient/${patient.id}` },
    subscriberId: opts.memberId,
    payor: [{ display: opts.payer }],
  });
  const elig = await checkEligibility(opts.payer);
  await writeAudit(store, {
    subtype: 'intake',
    description: `New patient registered via copilot; eligibility 270/271 → plan ${elig.planStatus}, prior-auth indicator ${elig.authOrCertIndicator}${elig.simulated ? ' (simulated)' : ''}`,
    entities: [`Patient/${patient.id}`],
  });
  return {
    summary:
      `Registered ${opts.name} (MRN ${mrn}) with ${opts.payer}${opts.memberId ? ` member ${opts.memberId}` : ''}. ` +
      `Eligibility check: plan ${elig.planStatus}; prior authorization ${elig.authOrCertIndicator === 'Y' ? 'REQUIRED for imaging — the triage agent will catch this' : 'not indicated'}.`,
    mrn,
  };
}

/** Look up a registered patient's insurance and run a fresh 270/271 eligibility check. */
export async function checkCoverage(patientName: string): Promise<{ summary: string }> {
  const store = await getStore();
  const patient = await findPatientByName(store, patientName);
  if (!patient) return { summary: `No patient named "${patientName}" is registered yet.` };
  const coverage = await coverageFor(store, `Patient/${patient.id}`);
  const payer = coverage?.payor?.[0]?.display;
  if (!payer) return { summary: `${patientDisplayName(patient)} is registered but has no insurance on file.` };
  const elig = await checkEligibility(payer);
  return {
    summary:
      `${patientDisplayName(patient)} is covered by ${payer}${coverage?.subscriberId ? ` (member ${coverage.subscriberId})` : ''}; ` +
      `eligibility check says the plan is ${elig.planStatus}, and prior authorization ${
        elig.authOrCertIndicator === 'Y' ? 'is required for imaging services' : 'is not indicated'
      }.`,
  };
}


/**
 * AI checkout: ends the visit. Marks the booked appointment fulfilled, writes
 * the finished Encounter (which is the REAL trigger the discharge agent
 * subscribes to — post-visit outreach fires through the full pipeline), and
 * drafts the visit claim so the insurance story can continue on this patient.
 */
export async function completeVisit(
  opts: { patientName: string; procedure?: string; amount?: number },
  onStep?: (event: PipelineStepEvent) => void,
): Promise<{ summary: string; claimIdentifier: string; pipeline?: PipelineResult }> {
  const store = await getStore();
  const patient = await findPatientByName(store, opts.patientName);
  if (!patient) throw new Error(`No patient named '${opts.patientName}' — register them first`);
  const patientRef = { reference: `Patient/${patient.id}` };
  const procedure = opts.procedure ?? 'Office visit — new patient check-up';

  await fulfilNextBooked(patientRef.reference, store);

  const suffix = shortId();
  const now = new Date();
  const encounter = await store.create<Encounter>({
    resourceType: 'Encounter',
    identifier: [{ system: IDS, value: `VISIT-${suffix}` }],
    status: 'finished',
    class: { code: 'AMB', display: 'ambulatory' },
    type: [{ text: procedure }],
    subject: patientRef,
    period: { start: new Date(now.getTime() - 30 * 60_000).toISOString(), end: now.toISOString() },
  });

  const claimIdentifier = `VISIT-CLM-${suffix}`;
  const coverage = (await store.search<Coverage>('Coverage', { beneficiary: patientRef.reference }))[0];
  await store.create<Claim>({
    resourceType: 'Claim',
    identifier: [{ system: IDS, value: claimIdentifier }],
    status: 'draft',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
    use: 'claim',
    patient: patientRef,
    created: now.toISOString(),
    provider: { display: 'Lakeside Family Clinic' },
    priority: { coding: [{ code: 'normal' }] },
    insurance: [{ sequence: 1, focal: true, coverage: { display: coverage?.payor?.[0]?.display ?? 'Self-pay' } }],
    item: [{ sequence: 1, productOrService: { text: procedure } }],
    total: { value: opts.amount ?? 180, currency: 'USD' },
  });

  const pipeline = await runPipeline(encounter, onStep);
  return {
    summary:
      `Visit complete for ${patientDisplayName(patient)}. Discharge outreach ${pipeline.status}: ${pipeline.detail ?? ''}. ` +
      `Visit claim ${claimIdentifier} ($${opts.amount ?? 180}) drafted and sitting in Ready.`,
    claimIdentifier,
    pipeline,
  };
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
