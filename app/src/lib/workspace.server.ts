import 'server-only';
import type {
  Claim,
  ClaimResponse,
  Communication,
  Coverage,
  Encounter,
  Patient,
  ServiceRequest,
  Task,
} from '@medplum/fhirtypes';
import { getStore, type FhirStore } from './medplum.server';
import { formatSlot, listCalendar, type CalendarAppointment } from './appointments.server';
import { bookedByLabel } from './calendar';
import type { TimelineEvent } from './chart';
import { patientDisplayName } from './patients.server';
import { isDenied, parseDenial } from './intents/shared';

/**
 * Read models for the clinician workspace pages (Patients, Claims, Schedule).
 * This is the EHR-side authorized view — clinicians legitimately see their own
 * patients' demo data here; the redaction guarantee is about what leaves the
 * server to EXTERNAL services (LLM, Moss, PubMed), which stays enforced by
 * the pipeline. All data below comes straight from FHIR resources in the
 * store, so everything the agents do (book appointments, complete screenings,
 * resolve claims) shows up on these pages on the next refresh.
 */

export interface PatientSummary {
  id: string;
  name: string;
  mrn?: string;
  dob?: string;
  phone?: string;
  payer?: string;
  planId?: string;
}

// The timeline event shape lives in chart.ts so client components can import it
// without pulling in this `server-only` module.
export type { TimelineEvent } from './chart';

/**
 * Every resource one patient's story is built from, fetched once. The journey
 * and the chart's FHIR tab are two views of this bundle, not two round-trips.
 */
export interface PatientRecord {
  patient: Patient;
  encounters: Encounter[];
  claims: Claim[];
  responses: ClaimResponse[];
  serviceRequests: ServiceRequest[];
  appointments: CalendarAppointment[];
  tasks: Task[];
  communications: Communication[];
}

function mrnOf(p: Patient): string | undefined {
  return p.identifier?.find((i) => i.value?.startsWith('MRN'))?.value ?? p.identifier?.[0]?.value;
}

export async function listPatients(store?: FhirStore): Promise<PatientSummary[]> {
  const db = store ?? (await getStore());
  const [patients, coverages] = await Promise.all([
    db.search<Patient>('Patient', {}),
    db.search<Coverage>('Coverage', {}),
  ]);
  return patients.map((p) => {
    const cov = coverages.find((c) => c.beneficiary?.reference === `Patient/${p.id}`);
    return {
      id: p.id!,
      name: patientDisplayName(p),
      mrn: mrnOf(p),
      dob: p.birthDate,
      phone: p.telecom?.find((t) => t.system === 'phone')?.value,
      payer: cov?.payor?.[0]?.display,
      planId: cov?.identifier?.[0]?.value ?? cov?.subscriberId,
    };
  });
}

/** Fetch every resource behind one patient's story. Undefined when the id is unknown. */
export async function patientRecord(patientId: string, store?: FhirStore): Promise<PatientRecord | undefined> {
  const db = store ?? (await getStore());
  const ref = `Patient/${patientId}`;
  const [patient, encounters, claims, responses, serviceRequests, appointments, tasks, communications] =
    await Promise.all([
      db.read<Patient>('Patient', patientId),
      db.search<Encounter>('Encounter', { subject: ref }),
      db.search<Claim>('Claim', { patient: ref }),
      db.search<ClaimResponse>('ClaimResponse', { patient: ref }),
      db.search<ServiceRequest>('ServiceRequest', { subject: ref }),
      listCalendar({ patientId, includeCancelled: true, store: db }),
      // 'for' isn't a portable search param (Medplum uses 'patient'; the memory
      // store supports neither) — fetch all and filter here.
      db.search<Task>('Task', {}).then((all) => all.filter((t) => t.for?.reference === ref)),
      db.search<Communication>('Communication', { subject: ref }),
    ]);

  if (!patient) return undefined;
  return { patient, encounters, claims, responses, serviceRequests, appointments, tasks, communications };
}

export async function patientTimeline(patientId: string, store?: FhirStore): Promise<TimelineEvent[]> {
  const record = await patientRecord(patientId, store);
  return record ? timelineFrom(record) : [];
}

/** Pure: the patient's bundle rendered as journey events, newest first. */
export function timelineFrom(record: PatientRecord): TimelineEvent[] {
  const {
    patient,
    encounters,
    claims,
    responses,
    serviceRequests: srs,
    appointments: appts,
    tasks,
    communications: comms,
  } = record;

  const events: TimelineEvent[] = [];

  if (patient?.meta?.lastUpdated) {
    events.push({
      at: patient.meta.lastUpdated,
      kind: 'intake',
      title: 'Patient registered',
      detail: `Intake complete — demographics, contact, and coverage on file`,
    });
  }

  for (const e of encounters) {
    events.push({
      at: e.period?.end ?? e.period?.start ?? e.meta?.lastUpdated ?? '',
      kind: 'encounter',
      title: e.status === 'finished' ? 'Encounter finished (discharged)' : `Encounter ${e.status}`,
      detail: e.type?.[0]?.text ?? e.class?.display ?? undefined,
      badge:
        e.status === 'finished'
          ? { label: 'discharged', tone: 'neutral' }
          : { label: e.status ?? 'active', tone: 'accent' },
    });
  }

  for (const sr of srs) {
    const label = sr.code?.text ?? sr.code?.coding?.[0]?.display ?? 'Order';
    events.push({
      at: sr.authoredOn ?? sr.meta?.lastUpdated ?? '',
      kind: 'order',
      title: `Order: ${label}`,
      detail: sr.note?.[0]?.text?.slice(0, 140),
      badge:
        sr.status === 'completed'
          ? { label: 'completed', tone: 'good' }
          : { label: sr.status ?? 'active', tone: 'neutral' },
    });
  }

  for (const c of claims) {
    events.push({
      at: c.created ?? c.meta?.lastUpdated ?? '',
      kind: 'claim',
      title: `Claim ${c.identifier?.[0]?.value ?? c.id} — $${c.total?.value?.toLocaleString() ?? '—'}`,
      detail: c.item?.[0]?.productOrService?.text ?? c.item?.[0]?.productOrService?.coding?.[0]?.display,
      badge: { label: c.status ?? 'draft', tone: 'neutral' },
    });
  }

  for (const cr of responses) {
    if (cr.outcome === 'complete') {
      events.push({
        at: cr.created ?? '',
        kind: 'approval',
        title: `Payer approved — $${cr.payment?.amount?.value?.toLocaleString() ?? '—'} paid`,
        detail: cr.disposition,
        badge: { label: 'paid', tone: 'good' },
      });
    } else if (isDenied(cr)) {
      const d = parseDenial(cr);
      events.push({
        at: cr.created ?? '',
        kind: 'denial',
        title: `Claim denied — ${d.code} (${d.label})`,
        detail: cr.disposition,
        badge: { label: d.code, tone: 'bad' },
      });
    }
  }

  for (const t of tasks) {
    events.push({
      at: t.authoredOn ?? t.meta?.lastUpdated ?? '',
      kind: 'agent',
      title: `Agent: ${t.code?.text ?? 'task'}`,
      detail: t.description,
      badge:
        t.status === 'completed'
          ? { label: 'completed', tone: 'good' }
          : { label: t.status ?? 'requested', tone: t.status === 'failed' ? 'bad' : 'neutral' },
    });
  }

  // Booking and its later outcome are two separate moments — "booked Aug 1,
  // cancelled Aug 3" is the true story, and the timeline already sorts by `at`.
  for (const a of appts) {
    events.push({
      at: a.createdAt ?? a.updatedAt ?? a.start ?? '',
      kind: 'appointment',
      title: `Appointment booked: ${a.description}`,
      detail: `${formatSlot(a.start, a.end)} · by the ${bookedByLabel(a.bookedBy)}`,
      badge: { label: 'booked', tone: 'accent' },
    });
    if (a.status === 'cancelled') {
      events.push({
        at: a.updatedAt ?? '',
        kind: 'appointment',
        title: `Appointment cancelled: ${a.description}`,
        detail: a.cancelledReason,
        badge: { label: 'cancelled', tone: 'bad' },
      });
    } else if (a.status === 'fulfilled') {
      events.push({
        at: a.updatedAt ?? '',
        kind: 'appointment',
        title: `Visit completed: ${a.description}`,
        badge: { label: 'completed', tone: 'good' },
      });
    }
  }

  for (const m of comms) {
    events.push({
      at: m.sent ?? m.meta?.lastUpdated ?? '',
      kind: 'message',
      title: m.category?.[0]?.text === 'voice-transcript' ? 'Call transcript recorded' : `Record: ${m.category?.[0]?.text ?? 'communication'}`,
      detail: m.payload?.[0]?.contentString?.slice(0, 160),
    });
  }

  return events.filter((e) => e.at).sort((a, b) => b.at.localeCompare(a.at));
}

// ── Claims board ────────────────────────────────────────────────────────────

export type ClaimStage = 'ready' | 'submitted' | 'denied' | 'needs-review' | 'appealed' | 'paid';

export interface ClaimCard {
  id: string;
  identifier: string;
  patientName: string;
  payer: string;
  amount?: number;
  procedure?: string;
  stage: ClaimStage;
  denialCode?: string;
  denialLabel?: string;
  updatedAt: string;
}

export async function claimsBoard(): Promise<ClaimCard[]> {
  const store = await getStore();
  const [claims, responses, tasks, patients, coverages] = await Promise.all([
    store.search<Claim>('Claim', {}),
    store.search<ClaimResponse>('ClaimResponse', {}),
    store.search<Task>('Task', {}),
    store.search<Patient>('Patient', {}),
    store.search<Coverage>('Coverage', {}),
  ]);

  return claims.map((claim) => {
    const claimRef = `Claim/${claim.id}`;
    const crs = responses
      .filter((r) => r.request?.reference === claimRef)
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
    const latest = crs[0];

    let stage: ClaimStage = claim.status === 'active' ? 'submitted' : 'ready';
    let denialCode: string | undefined;
    let denialLabel: string | undefined;
    let updatedAt = claim.meta?.lastUpdated ?? claim.created ?? '';

    if (latest) {
      updatedAt = latest.created ?? updatedAt;
      if (latest.outcome === 'complete') {
        stage = 'paid';
      } else if (isDenied(latest)) {
        const d = parseDenial(latest);
        denialCode = d.code;
        denialLabel = d.label;
        const appealTasks = tasks.filter(
          (t) =>
            t.focus?.reference === `ClaimResponse/${latest.id}` &&
            t.code?.coding?.some((c) => c.code === 'denial-appeal'),
        );
        // 'requested' = draft parked for human sign-off; 'completed' = appeal sent.
        stage = appealTasks.some((t) => t.status === 'completed')
          ? 'appealed'
          : appealTasks.some((t) => t.status === 'requested')
            ? 'needs-review'
            : 'denied';
      }
    }

    const patient = patients.find((p) => `Patient/${p.id}` === claim.patient?.reference);
    const coverage = coverages.find((c) => c.beneficiary?.reference === claim.patient?.reference);
    return {
      id: claim.id!,
      identifier: claim.identifier?.[0]?.value ?? claim.id!,
      patientName: patient ? patientDisplayName(patient) : 'Unknown',
      payer: coverage?.payor?.[0]?.display ?? 'Payer',
      amount: claim.total?.value,
      procedure: claim.item?.[0]?.productOrService?.text ?? claim.item?.[0]?.productOrService?.coding?.[0]?.display,
      stage,
      denialCode,
      denialLabel,
      updatedAt,
    };
  });
}

// ── Patient portal (what the patient sees) ──────────────────────────────────

export interface PortalItem {
  at: string;
  kind: 'message' | 'visit' | 'insurance_win' | 'insurance_fight' | 'screening';
  title: string;
  body?: string;
}

/**
 * The consumer-facing side of the same events: while the agents work the
 * back office, the patient's phone quietly fills with good news. Everything
 * here is derived from the same FHIR resources as the clinician pages.
 */
export async function patientPortal(
  selected?: string,
): Promise<{ patient?: PatientSummary; items: PortalItem[]; patients: PatientSummary[] }> {
  const patients = await listPatients();
  // Explicit selection (from the ?p= switcher) wins over the auto-follow.
  if (selected) {
    const chosen = patients.find((p) => p.id === selected || p.mrn === selected);
    if (chosen) return { patient: chosen, items: await portalItemsFor(chosen), patients };
  }
  // The phone follows the story: whoever got the most recent appointment or
  // outreach owns it (so a live-registered patient takes over the moment the
  // agents touch them), falling back to the seed demo hero.
  const store0 = await getStore();
  const [allAppts, allComms] = await Promise.all([
    listCalendar({ store: store0 }),
    store0.search<Communication>('Communication', {}),
  ]);
  const latestByPatient = new Map<string, string>();
  for (const a of allAppts) {
    // Rank on when it was BOOKED, not last touched — otherwise cancelling a
    // visit would make the phone jump to that patient.
    const pref = a.patientId ? `Patient/${a.patientId}` : undefined;
    const at = a.createdAt ?? a.start ?? '';
    if (pref && at > (latestByPatient.get(pref) ?? '')) latestByPatient.set(pref, at);
  }
  for (const m of allComms) {
    if (m.category?.[0]?.text !== 'outreach message') continue;
    const pref = m.subject?.reference;
    const at = m.sent ?? m.meta?.lastUpdated ?? '';
    if (pref && at > (latestByPatient.get(pref) ?? '')) latestByPatient.set(pref, at);
  }
  const activeRef = [...latestByPatient.entries()].sort((a, b) => b[1].localeCompare(a[1]))[0]?.[0];
  const patient =
    patients.find((p) => `Patient/${p.id}` === activeRef) ??
    patients.find((p) => p.mrn === 'MRN-001234') ??
    patients[0];
  if (!patient) return { patient: undefined, items: [], patients };
  return { patient, items: await portalItemsFor(patient), patients };
}

async function portalItemsFor(patient: PatientSummary): Promise<PortalItem[]> {
  const store = await getStore();
  const ref = `Patient/${patient.id}`;
  const firstName = patient.name.split(' ')[0];

  const [comms, appts, srs, cards] = await Promise.all([
    store.search<Communication>('Communication', { subject: ref }),
    listCalendar({ patientId: patient.id, includeCancelled: true, store }),
    store.search<ServiceRequest>('ServiceRequest', { subject: ref }),
    claimsBoard(),
  ]);

  const items: PortalItem[] = [];

  for (const m of comms) {
    if (m.category?.[0]?.text !== 'outreach message') continue;
    items.push({
      at: m.sent ?? m.meta?.lastUpdated ?? '',
      kind: 'message',
      title: 'Message from your care team',
      body: m.payload?.[0]?.contentString?.slice(0, 420),
    });
  }

  for (const a of appts) {
    const cancelled = a.status === 'cancelled';
    items.push({
      at: (cancelled ? a.updatedAt : a.createdAt) ?? a.start ?? '',
      kind: 'visit',
      title: cancelled ? `Your ${a.description.toLowerCase()} was cancelled` : a.description,
      body: cancelled
        ? 'Give us a call whenever you want to rebook — no rush.'
        : `${formatSlot(a.start, a.end)} — no action needed, just show up.`,
    });
  }

  for (const sr of srs) {
    if (sr.status !== 'completed') continue;
    const label = sr.code?.text ?? sr.code?.coding?.[0]?.display ?? 'screening';
    items.push({
      at: sr.meta?.lastUpdated ?? '',
      kind: 'screening',
      title: `Your ${label.toLowerCase()} is taken care of`,
      body: 'It was overdue, so we booked it for you during your check-in call.',
    });
  }

  for (const c of cards) {
    if (c.patientName !== patient.name) continue;
    if (c.stage === 'paid') {
      items.push({
        at: c.updatedAt,
        kind: 'insurance_win',
        title: 'Good news about your insurance',
        body: `${c.payer} approved your ${c.procedure ?? 'claim'}${c.amount != null ? ` ($${c.amount.toLocaleString()})` : ''}. Your balance for this visit is $0.`,
      });
    } else if (c.stage === 'denied' || c.stage === 'needs-review' || c.stage === 'appealed') {
      items.push({
        at: c.updatedAt,
        kind: 'insurance_fight',
        title: "We're handling an insurance issue for you",
        body: `${c.payer} initially declined your ${c.procedure ?? 'claim'}${c.denialLabel ? ` (${c.denialLabel.toLowerCase()})` : ''}. ${firstName}, you don't need to do anything — we've already filed an appeal with supporting medical evidence.`,
      });
    }
  }

  return items.filter((i) => i.at).sort((a, b) => b.at.localeCompare(a.at));
}

/** Dollars recovered via approvals after appeal — the layman headline number. */
export async function moneyRecovered(): Promise<number> {
  const store = await getStore();
  const responses = await store.search<ClaimResponse>('ClaimResponse', {});
  return responses
    .filter((r) => r.outcome === 'complete')
    .reduce((s, r) => s + (r.payment?.amount?.value ?? 0), 0);
}

// The Schedule read model lives in appointments.server.ts — the calendar row
// changes for the same reasons the write paths do, so they share one module.
