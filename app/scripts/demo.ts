/**
 * Demo event driver. Creates real FHIR resources in the store, then POSTs
 * them to the local webhook with the same payload shape (and HMAC signature)
 * a Medplum Subscription rest-hook would use — so the exact same code path
 * runs with or without Medplum cloud. Duplicate deliveries are deduped by
 * the pipeline's Task-by-focus idempotency check.
 *
 * Suggested arc (the self-improvement loop):
 *   1. npm run demo -- deny                        → appeal drafted (CO-197, claim 1)
 *   2. npm run demo -- approve                     → appeal WON; playbook learned + re-indexed into Moss
 *   3. npm run demo -- deny --claim DEMO-CLAIM-2   → retrieval now cites learned-CO-197
 */
import { createHmac } from 'node:crypto';
import type { Claim, ClaimResponse, Coverage, Encounter, Patient, Resource, ServiceRequest } from '@medplum/fhirtypes';
import { getStore, type FhirStore } from '@/lib/medplum.server';
import { listEpisodic } from '@/lib/memory/episodic';
import { loadPlaybook } from '@/lib/memory/playbook';

const IDS = 'https://autonomous-backoffice.dev/demo';
const CARC = 'https://x12.org/codes/claim-adjustment-reason-codes';
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

const DENIAL_TEXTS: Record<string, string> = {
  'CO-197': 'Precertification/authorization/notification absent.',
  'CO-50': 'These are non-covered services because this is not deemed a medical necessity by the payer.',
  'CO-16': 'Claim/service lacks information or has submission/billing error(s).',
  'CO-29': 'The time limit for filing has expired.',
  'CO-11': 'The diagnosis is inconsistent with the procedure.',
};

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, dflt?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

async function findByIdentifier<T extends Resource>(store: FhirStore, type: T['resourceType'], value: string): Promise<T> {
  const found = (await store.search<T>(type, { identifier: value }))[0];
  if (!found) throw new Error(`${type} '${value}' not found — run \`npm run seed\` first`);
  return found;
}

async function fireWebhook(resource: Resource): Promise<void> {
  const body = JSON.stringify(resource);
  const headers: Record<string, string> = { 'content-type': 'application/fhir+json' };
  const secret = process.env.MEDPLUM_WEBHOOK_SECRET;
  if (secret) headers['x-signature'] = createHmac('sha256', secret).update(body).digest('hex');
  const res = await fetch(`${APP_URL}/api/webhooks/medplum`, { method: 'POST', headers, body });
  const json = await res.json().catch(() => ({}));
  console.log(`→ POST ${APP_URL}/api/webhooks/medplum [${res.status}]`, json);
  if (!res.ok) process.exitCode = 1;
}

async function payerFor(store: FhirStore, patientRef?: string): Promise<string> {
  if (!patientRef) return 'Blue Shield PPO';
  const coverage = (await store.search<Coverage>('Coverage', { beneficiary: patientRef }))[0];
  return coverage?.payor?.[0]?.display ?? 'Blue Shield PPO';
}

async function deny(store: FhirStore): Promise<void> {
  const claimId = opt('claim', 'DEMO-CLAIM-1')!;
  const code = opt('code', 'CO-197')!;
  const text = DENIAL_TEXTS[code] ?? `Claim denied (${code}).`;
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
    error: [{ code: { coding: [{ system: CARC, code, display: DENIAL_TEXTS[code] }] } }],
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
  console.log(`+ ClaimResponse/${cr.id} — DENIAL ${code} on ${claimId}`);
  await fireWebhook(cr);
}

async function approve(store: FhirStore): Promise<void> {
  const claimId = opt('claim', 'DEMO-CLAIM-1')!;
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
  console.log(`+ ClaimResponse/${cr.id} — APPROVAL on ${claimId} (${amount} USD)`);
  await fireWebhook(cr);
}

async function triage(store: FhirStore): Promise<void> {
  const claimId = opt('claim', 'DEMO-CLAIM-1')!;
  const claim = await findByIdentifier<Claim>(store, 'Claim', claimId);
  const updated = await store.update<Claim>({ ...claim, status: 'active' });
  console.log(`~ Claim/${updated.id} (${claimId}) → active`);
  await fireWebhook(updated);
}

async function discharge(store: FhirStore): Promise<void> {
  const enc = await findByIdentifier<Encounter>(store, 'Encounter', 'DEMO-ENC-1');
  const updated = await store.update<Encounter>({
    ...enc,
    status: 'finished',
    period: { ...enc.period, end: new Date().toISOString() },
  });
  console.log(`~ Encounter/${updated.id} → finished (discharge)`);
  await fireWebhook(updated);
}

async function priorAuth(store: FhirStore): Promise<void> {
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
  console.log(`+ ServiceRequest/${sr.id} — MRI lumbar (prior auth required)`);
  await fireWebhook(sr);
}

async function status(store: FhirStore): Promise<void> {
  const [episodic, playbook, tasks] = await Promise.all([
    listEpisodic(store),
    loadPlaybook(store),
    store.search('Task', {}),
  ]);
  console.log(`store: ${store.mode}`);
  console.log(`episodic runs: ${episodic.length} (${episodic.filter((e) => e.outcome === 'won').length} won, ${episodic.filter((e) => e.outcome === 'lost').length} lost, ${episodic.filter((e) => e.outcome === 'pending').length} pending)`);
  console.log(`playbook entries: ${playbook.map((p) => `${p.denialCode}[${p.wins}W/${p.losses}L/${p.attempts}A]`).join(' ') || 'none'}`);
  console.log(`tasks: ${tasks.length}`);
  for (const e of episodic.slice(0, 5)) {
    console.log(`  ${e.createdAt} ${e.intent} ${e.decision} → ${e.outcome} (sources: ${e.retrievedSourceIds.join(', ') || 'none'})`);
  }
}

const USAGE = `Usage: npm run demo -- <command> [options]

Commands:
  deny        [--claim DEMO-CLAIM-1] [--code CO-197|CO-50|CO-16|CO-29|CO-11]
  approve     [--claim DEMO-CLAIM-1]        payer approves → feedback marks appeal WON
  triage      [--claim DEMO-CLAIM-1]        claim → active, wakes claim-triage
  discharge                                 encounter → finished, wakes discharge-caregap
  prior-auth                                creates an MRI order, wakes prior-auth-docs
  status                                    print memory/task counts

Self-improvement demo arc:
  1. npm run demo -- deny
  2. npm run demo -- approve
  3. npm run demo -- deny --claim DEMO-CLAIM-2   ← retrieval now cites learned-CO-197`;

async function main(): Promise<void> {
  const store = await getStore();
  switch (cmd) {
    case 'deny': return deny(store);
    case 'approve': return approve(store);
    case 'triage': return triage(store);
    case 'discharge': return discharge(store);
    case 'prior-auth': return priorAuth(store);
    case 'status': return status(store);
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
