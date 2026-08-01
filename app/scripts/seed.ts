/**
 * Seed the demo world: Jane Doe (Blue Shield PPO), an in-progress surgery
 * encounter, an overdue screening mammogram (the care gap), and two draft MRI
 * claims. Idempotent — safe to re-run. Works against real Medplum or the
 * file-backed demo store.
 */
import type {
  Claim,
  Coverage,
  Encounter,
  Organization,
  Patient,
  Practitioner,
  Resource,
  ServiceRequest,
} from '@medplum/fhirtypes';
import { getStore, type FhirStore } from '@/lib/medplum.server';
import { recordVitals } from '@/lib/vitals.server';

const IDS = 'https://autonomous-backoffice.dev/demo';
/** Fixed so re-seeding is a genuine no-op, not a restamp. */
const SEED_VITALS_AT = '2026-07-28T17:00:00.000Z';
const CPT = 'http://www.ama-assn.org/go/cpt';
const ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm';

async function ensure<T extends Resource>(
  store: FhirStore,
  type: T['resourceType'],
  identifierValue: string,
  build: () => T,
): Promise<T> {
  const existing = await store.search<T>(type, { identifier: identifierValue });
  if (existing[0]) {
    console.log(`= ${type} ${identifierValue} already exists (${existing[0].id})`);
    return existing[0];
  }
  const created = await store.create<T>(build());
  console.log(`+ ${type} ${identifierValue} → ${created.id}`);
  return created;
}

async function main(): Promise<void> {
  const store = await getStore();
  console.log(`[seed] store mode: ${store.mode}\n`);

  const org = await ensure<Organization>(store, 'Organization', 'DEMO-ORG-1', () => ({
    resourceType: 'Organization',
    identifier: [{ system: IDS, value: 'DEMO-ORG-1' }],
    name: 'Bayview Imaging Group',
  }));

  await ensure<Practitioner>(store, 'Practitioner', 'DEMO-PRACT-1', () => ({
    resourceType: 'Practitioner',
    identifier: [{ system: IDS, value: 'DEMO-PRACT-1' }],
    name: [{ given: ['Alex'], family: 'Li', prefix: ['Dr.'] }],
  }));

  const patient = await ensure<Patient>(store, 'Patient', 'MRN-001234', () => ({
    resourceType: 'Patient',
    identifier: [{ system: `${IDS}/mrn`, value: 'MRN-001234' }],
    name: [{ given: ['Jane', 'Q'], family: 'Doe' }],
    birthDate: '1968-04-12',
    gender: 'female',
    telecom: [
      { system: 'phone', value: '+15555550123' },
      { system: 'email', value: 'jane.doe@example.com' },
    ],
    address: [{ line: ['123 Harbor Lane'], city: 'Oakland', state: 'CA', postalCode: '94607' }],
  }));
  const patientRef = `Patient/${patient.id}`;

  // ensure() never touches an existing row, so a store seeded before `gender`
  // existed would stay blank forever without this.
  if (!patient.gender) {
    await store.update<Patient>({ ...patient, gender: 'female' });
    console.log('~ Patient MRN-001234 gender backfilled');
  }

  // Idempotent by identifier, the same contract ensure() gives everything else.
  // observedAt is fixed rather than `now` so re-seeding changes nothing at all —
  // a moving timestamp would restamp the readings and mark every chart overview
  // stale on each run.
  await recordVitals({
    patientId: patient.id,
    vitals: { heightCm: 168, weightKg: 67.1, systolic: 128, diastolic: 82, heartRate: 74, observedAt: SEED_VITALS_AT },
    identifierPrefix: 'VITAL-MRN-001234',
    store,
  });
  console.log('+ Observation vitals for MRN-001234 (height, weight, BP, heart rate)');

  const coverage = await ensure<Coverage>(store, 'Coverage', 'DEMO-COV-1', () => ({
    resourceType: 'Coverage',
    identifier: [{ system: IDS, value: 'DEMO-COV-1' }],
    status: 'active',
    beneficiary: { reference: patientRef },
    subscriberId: 'BSC123456789',
    payor: [{ display: 'Blue Shield PPO' }],
  }));

  await ensure<Encounter>(store, 'Encounter', 'DEMO-ENC-1', () => ({
    resourceType: 'Encounter',
    identifier: [{ system: IDS, value: 'DEMO-ENC-1' }],
    status: 'in-progress', // flipped to 'finished' by `npm run demo -- discharge`
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    type: [{ text: 'Outpatient surgery' }],
    subject: { reference: patientRef },
    period: { start: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
    diagnosis: [{ condition: { display: 'Laparoscopic cholecystectomy' } }],
  }));

  await ensure<ServiceRequest>(store, 'ServiceRequest', 'DEMO-SR-MAMMO', () => ({
    resourceType: 'ServiceRequest',
    identifier: [{ system: IDS, value: 'DEMO-SR-MAMMO' }],
    status: 'active',
    intent: 'order',
    subject: { reference: patientRef },
    code: { coding: [{ system: CPT, code: '77067', display: 'Screening mammography, bilateral' }], text: 'Screening mammogram' },
    authoredOn: '2024-06-01',
    occurrenceDateTime: '2024-06-15', // long past → overdue care gap
    reasonCode: [{ text: 'Routine preventive screening' }],
  }));

  const mkClaim = (id: string, cpt: string, cptDisplay: string, dxCode: string, dxDisplay: string, amount: number, note: string): Claim => ({
    resourceType: 'Claim',
    identifier: [{ system: IDS, value: id }],
    status: 'draft', // flipped to 'active' by `npm run demo -- triage`
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
    use: 'claim',
    patient: { reference: patientRef },
    created: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
    provider: { reference: `Organization/${org.id}`, display: 'Bayview Imaging Group' },
    priority: { coding: [{ code: 'normal' }] },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${coverage.id}` } }],
    diagnosis: [{ sequence: 1, diagnosisCodeableConcept: { coding: [{ system: ICD10, code: dxCode, display: dxDisplay }] } }],
    item: [
      {
        sequence: 1,
        productOrService: { coding: [{ system: CPT, code: cpt, display: cptDisplay }], text: cptDisplay },
        net: { value: amount, currency: 'USD' },
      },
    ],
    supportingInfo: [{ sequence: 1, category: { text: 'clinical-note' }, valueString: note }],
    total: { value: amount, currency: 'USD' },
  });

  await ensure<Claim>(store, 'Claim', 'DEMO-CLAIM-1', () =>
    mkClaim(
      'DEMO-CLAIM-1',
      '70553',
      'MRI brain with and without contrast',
      'G43.909',
      'Migraine, unspecified, not intractable',
      2400,
      '8 weeks of progressively worsening headaches with new visual aura and change in headache pattern; failed conservative therapy (NSAIDs, triptans) over 6+ weeks; neurological examination documented; treating-physician referral on file.',
    ),
  );

  await ensure<Claim>(store, 'Claim', 'DEMO-CLAIM-2', () =>
    mkClaim(
      'DEMO-CLAIM-2',
      '72148',
      'MRI lumbar spine without contrast',
      'M54.50',
      'Low back pain, unspecified',
      1750,
      '7 weeks of documented physical therapy and NSAIDs without improvement; progressive radicular symptoms with new motor weakness; treating-physician order on file.',
    ),
  );

  console.log('\n[seed] done. Next: npm run index-moss, then npm run dev, then npm run demo -- deny');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
