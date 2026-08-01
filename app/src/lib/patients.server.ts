import 'server-only';
import type { Communication, Coverage, Patient } from '@medplum/fhirtypes';
import { getStore, writeAudit, type FhirStore } from './medplum.server';
import { checkEligibility } from './stedi.server';

/**
 * The Patient and Coverage resources: who someone is, and who pays for them.
 *
 * Every write to either lives here — the intake form, the copilot's tools, and
 * the pipeline agents all call these same functions, so registration and
 * demographic edits have exactly one implementation and cannot drift. Reads of
 * the wider chart live in patientChart.server.ts.
 */

const IDS = 'https://autonomous-backoffice.dev/demo';

/**
 * One error type for every patient write, so the API boundary and the copilot
 * dispatcher each need ONE mapping. Mirrors AppointmentError; the message is
 * read aloud by the copilot, so write it as prose.
 */
export class PatientError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'PatientError';
  }
}

/** "Maria Lopez" — the full display name from the first HumanName. */
export function patientDisplayName(p: Patient): string {
  const n = p.name?.[0];
  return [n?.given?.join(' '), n?.family].filter(Boolean).join(' ') || 'Unknown patient';
}

/**
 * "Maria L." — what a shared front-desk screen shows. Used for bulk calendar
 * reads that reach the LLM, so a whole day's roster never leaves as full names.
 */
export function shortDisplayName(p: Patient): string {
  const n = p.name?.[0];
  const given = n?.given?.[0];
  const initial = n?.family?.[0];
  if (!given) return patientDisplayName(p);
  return initial ? `${given} ${initial}.` : given;
}

/**
 * Fuzzy front-desk lookup: exact, then every word of the query present in the
 * name, then the query as a substring of a longer name.
 *
 * The word pass is what makes "Jane Doe" find "Jane Q Doe" — people say a first
 * and last name, charts carry middle names, and no substring test bridges that.
 *
 * Matching deliberately runs one way only. The reverse ("is the stored name
 * inside the query?") lets a shorter record swallow a longer query — a patient
 * recorded as "Patient" would answer to "Test Patient" — which registers a
 * duplicate against the wrong chart and, now that charts are editable, would
 * edit the wrong person.
 */
export async function findPatientByName(store: FhirStore, name: string): Promise<Patient | undefined> {
  const patients = await store.search<Patient>('Patient', {});
  const q = name.trim().toLowerCase();
  if (!q) return undefined;
  const words = q.split(/\s+/);
  return (
    patients.find((p) => patientDisplayName(p).toLowerCase() === q) ??
    patients.find((p) => {
      const parts = patientDisplayName(p).toLowerCase().split(/\s+/);
      return words.every((w) => parts.includes(w));
    }) ??
    patients.find((p) => patientDisplayName(p).toLowerCase().includes(q))
  );
}

/** Resolve a patient by id or by name, the two ways every caller addresses one. */
export async function requirePatient(
  store: FhirStore,
  opts: { patientId?: string; patientName?: string },
): Promise<Patient> {
  const patient = opts.patientId
    ? await store.read<Patient>('Patient', opts.patientId)
    : opts.patientName
      ? await findPatientByName(store, opts.patientName)
      : undefined;
  if (!patient?.id) {
    throw new PatientError(
      'not_found',
      `No patient matched ${opts.patientName ?? opts.patientId ?? 'that request'} — register them first.`,
    );
  }
  return patient;
}

// ── Writes ──────────────────────────────────────────────────────────────────

function shortId(): string {
  return Date.now().toString(36).toUpperCase().slice(-6);
}

/** Split "Jane Q Doe" the way FHIR wants it. */
function splitName(name: string): { given: string[]; family?: string } {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? { given: parts.slice(0, -1), family: parts[parts.length - 1] } : { given: parts };
}

export interface RegisterPatientResult {
  id: string;
  mrn: string;
  summary: string;
}

/**
 * Front-desk intake: creates the Patient and Coverage, then verifies the plan
 * over the Stedi 270/271 path — the same thing that happens when someone walks
 * up to the desk. Idempotent by name, because the panel is shared across
 * conversations and re-registering someone must not fork their record.
 */
export async function registerPatient(opts: {
  name: string;
  birthDate?: string;
  gender?: string;
  phone?: string;
  payer: string;
  memberId?: string;
  store?: FhirStore;
}): Promise<RegisterPatientResult> {
  const store = opts.store ?? (await getStore());
  if (!opts.name?.trim()) throw new PatientError('invalid_input', 'A name is needed to register someone.');
  if (!opts.payer?.trim()) throw new PatientError('invalid_input', 'An insurance company is needed to register someone.');

  const existing = await findPatientByName(store, opts.name);
  if (existing?.id) {
    const mrn = existing.identifier?.[0]?.value ?? existing.id;
    return {
      id: existing.id,
      mrn,
      summary: `${patientDisplayName(existing)} is already registered (MRN ${mrn}).`,
    };
  }

  const mrn = `MRN-NEW-${shortId()}`;
  const { given, family } = splitName(opts.name);
  const patient = await store.create<Patient>({
    resourceType: 'Patient',
    identifier: [{ system: IDS, value: mrn }],
    name: [{ given, family }],
    birthDate: opts.birthDate,
    gender: opts.gender as Patient['gender'],
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
    description: `New patient registered; eligibility 270/271 → plan ${elig.planStatus}, prior-auth indicator ${elig.authOrCertIndicator}${elig.simulated ? ' (simulated)' : ''}`,
    entities: [`Patient/${patient.id}`],
  });

  return {
    id: patient.id!,
    mrn,
    summary:
      `Registered ${opts.name} (MRN ${mrn}) with ${opts.payer}${opts.memberId ? ` member ${opts.memberId}` : ''}. ` +
      `Eligibility check: plan ${elig.planStatus}; prior authorization ${elig.authOrCertIndicator === 'Y' ? 'REQUIRED for imaging — the triage agent will catch this' : 'not indicated'}.`,
  };
}

/** Edit demographics in place. Only the fields given are touched. */
export async function updateDemographics(opts: {
  patientId?: string;
  patientName?: string;
  name?: string;
  sex?: string;
  birthDate?: string;
  phone?: string;
  email?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  store?: FhirStore;
}): Promise<{ summary: string; changed: string[] }> {
  const store = opts.store ?? (await getStore());
  const patient = await requirePatient(store, opts);
  const next: Patient = { ...patient };
  const changed: string[] = [];

  if (opts.name) {
    const { given, family } = splitName(opts.name);
    next.name = [{ given, family }];
    changed.push('name');
  }
  if (opts.sex) {
    next.gender = opts.sex as Patient['gender'];
    changed.push('sex');
  }
  if (opts.birthDate) {
    next.birthDate = opts.birthDate;
    changed.push('date of birth');
  }
  if (opts.phone || opts.email) {
    const telecom = [...(patient.telecom ?? [])].filter(
      (t) => !(opts.phone && t.system === 'phone') && !(opts.email && t.system === 'email'),
    );
    if (opts.phone) telecom.push({ system: 'phone', value: opts.phone, use: 'mobile' });
    if (opts.email) telecom.push({ system: 'email', value: opts.email });
    next.telecom = telecom;
    if (opts.phone) changed.push('phone');
    if (opts.email) changed.push('email');
  }
  if (opts.addressLine || opts.city || opts.state || opts.postalCode) {
    const current = patient.address?.[0] ?? {};
    next.address = [
      {
        ...current,
        line: opts.addressLine ? [opts.addressLine] : current.line,
        city: opts.city ?? current.city,
        state: opts.state ?? current.state,
        postalCode: opts.postalCode ?? current.postalCode,
      },
    ];
    changed.push('address');
  }

  if (changed.length === 0) throw new PatientError('invalid_input', 'No demographic fields were given to change.');

  await store.update<Patient>(next);
  await writeAudit(store, {
    subtype: 'demographics-updated',
    description: `Updated ${changed.join(', ')} for ${patientDisplayName(next)}`,
    entities: [`Patient/${patient.id}`],
  });
  return { summary: `Updated ${shortDisplayName(next)} — ${changed.join(', ')} on file.`, changed };
}

/**
 * Write a note onto the chart. Stored as a Communication, which puts it on the
 * patient's journey through the existing timeline mapping with no extra work —
 * and, because the portal only shows category 'outreach message', a clinical
 * note cannot leak onto the patient-facing view.
 */
export async function addClinicalNote(opts: {
  patientId?: string;
  patientName?: string;
  note: string;
  category?: string;
  store?: FhirStore;
}): Promise<{ summary: string }> {
  const store = opts.store ?? (await getStore());
  if (!opts.note?.trim()) throw new PatientError('invalid_input', 'A note needs some text.');
  const patient = await requirePatient(store, opts);
  const category = opts.category ?? 'clinical note';

  await store.create<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    category: [{ text: category }],
    subject: { reference: `Patient/${patient.id}` },
    sent: new Date().toISOString(),
    payload: [{ contentString: opts.note.trim() }],
  });

  await writeAudit(store, {
    subtype: 'clinical-note',
    description: `${category} added for ${patientDisplayName(patient)}`,
    entities: [`Patient/${patient.id}`],
  });
  return { summary: `Added a ${category} to ${shortDisplayName(patient)}'s chart.` };
}

/** Edit or create the patient's coverage; a payer change re-runs eligibility. */
export async function updateCoverage(opts: {
  patientId?: string;
  patientName?: string;
  payer?: string;
  memberId?: string;
  groupNumber?: string;
  status?: string;
  store?: FhirStore;
}): Promise<{ summary: string; changed: string[] }> {
  const store = opts.store ?? (await getStore());
  const patient = await requirePatient(store, opts);
  const ref = `Patient/${patient.id}`;
  const existing = (await store.search<Coverage>('Coverage', { beneficiary: ref }))[0];
  const changed: string[] = [];

  const payerChanged = Boolean(opts.payer && opts.payer !== existing?.payor?.[0]?.display);
  const next: Coverage = {
    ...(existing ?? {
      resourceType: 'Coverage',
      identifier: [{ system: IDS, value: `COV-${patient.identifier?.[0]?.value ?? patient.id}` }],
      beneficiary: { reference: ref },
    }),
    resourceType: 'Coverage',
    status: (opts.status as Coverage['status']) ?? existing?.status ?? 'active',
    beneficiary: { reference: ref },
    subscriberId: opts.memberId ?? existing?.subscriberId,
    payor: opts.payer ? [{ display: opts.payer }] : (existing?.payor ?? [{ display: 'Self-pay' }]),
  };
  if (opts.payer) changed.push('payer');
  if (opts.memberId) changed.push('member ID');
  if (opts.status) changed.push('status');
  if (opts.groupNumber) {
    next.class = [
      ...(existing?.class ?? []).filter((c) => !c.type?.coding?.some((x) => x.code === 'group')),
      { type: { coding: [{ code: 'group' }] }, value: opts.groupNumber },
    ];
    changed.push('group');
  }

  if (changed.length === 0) throw new PatientError('invalid_input', 'No coverage fields were given to change.');

  if (existing?.id) {
    await store.update<Coverage>(next);
  } else {
    await store.create<Coverage>(next);
  }

  let eligibility = '';
  if (payerChanged && next.payor?.[0]?.display) {
    const elig = await checkEligibility(next.payor[0].display);
    eligibility = ` Eligibility check: plan ${elig.planStatus}; prior authorization ${elig.authOrCertIndicator === 'Y' ? 'required for imaging' : 'not indicated'}.`;
  }

  await writeAudit(store, {
    subtype: 'coverage-updated',
    description: `Updated ${changed.join(', ')} for ${patientDisplayName(patient)}`,
    entities: [ref],
  });
  return {
    summary: `Updated coverage for ${shortDisplayName(patient)} — ${changed.join(', ')} on file.${eligibility}`,
    changed,
  };
}
