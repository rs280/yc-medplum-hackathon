import 'server-only';
import type {
  Appointment,
  Claim,
  ClaimResponse,
  Communication,
  Coverage,
  Encounter,
  Patient,
  ServiceRequest,
  Task,
} from '@medplum/fhirtypes';
import { getStore } from './medplum.server';
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

export interface TimelineEvent {
  at: string;
  kind:
    | 'intake'
    | 'encounter'
    | 'order'
    | 'claim'
    | 'denial'
    | 'approval'
    | 'agent'
    | 'appointment'
    | 'message';
  title: string;
  detail?: string;
  badge?: { label: string; tone: 'good' | 'bad' | 'neutral' | 'accent' };
}

function nameOf(p: Patient): string {
  const n = p.name?.[0];
  return [n?.given?.join(' '), n?.family].filter(Boolean).join(' ') || 'Unknown patient';
}

function mrnOf(p: Patient): string | undefined {
  return p.identifier?.find((i) => i.value?.startsWith('MRN'))?.value ?? p.identifier?.[0]?.value;
}

export async function listPatients(): Promise<PatientSummary[]> {
  const store = await getStore();
  const [patients, coverages] = await Promise.all([
    store.search<Patient>('Patient', {}),
    store.search<Coverage>('Coverage', {}),
  ]);
  return patients.map((p) => {
    const cov = coverages.find((c) => c.beneficiary?.reference === `Patient/${p.id}`);
    return {
      id: p.id!,
      name: nameOf(p),
      mrn: mrnOf(p),
      dob: p.birthDate,
      phone: p.telecom?.find((t) => t.system === 'phone')?.value,
      payer: cov?.payor?.[0]?.display,
      planId: cov?.identifier?.[0]?.value ?? cov?.subscriberId,
    };
  });
}

export async function patientTimeline(patientId: string): Promise<TimelineEvent[]> {
  const store = await getStore();
  const ref = `Patient/${patientId}`;
  const [patient, encounters, claims, responses, srs, appts, tasks, comms] = await Promise.all([
    store.read<Patient>('Patient', patientId),
    store.search<Encounter>('Encounter', { subject: ref }),
    store.search<Claim>('Claim', { patient: ref }),
    store.search<ClaimResponse>('ClaimResponse', { patient: ref }),
    store.search<ServiceRequest>('ServiceRequest', { subject: ref }),
    store.search<Appointment>('Appointment', {}),
    // 'for' isn't a portable search param (Medplum uses 'patient'; the memory
    // store supports neither) — fetch all and filter here.
    store.search<Task>('Task', {}).then((all) => all.filter((t) => t.for?.reference === ref)),
    store.search<Communication>('Communication', { subject: ref }),
  ]);

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

  for (const a of appts) {
    if (!a.participant?.some((p) => p.actor?.reference === ref)) continue;
    events.push({
      at: a.meta?.lastUpdated ?? a.start ?? '',
      kind: 'appointment',
      title: `Appointment booked: ${a.description ?? 'visit'}`,
      detail: a.start ? `Scheduled for ${new Date(a.start).toLocaleString()}` : undefined,
      badge: { label: a.status ?? 'booked', tone: 'accent' },
    });
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

export type ClaimStage = 'ready' | 'submitted' | 'denied' | 'appealed' | 'paid';

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
        const appealed = tasks.some(
          (t) =>
            t.focus?.reference === `ClaimResponse/${latest.id}` &&
            t.code?.coding?.some((c) => c.code === 'denial-appeal') &&
            t.status === 'completed',
        );
        stage = appealed ? 'appealed' : 'denied';
      }
    }

    const patient = patients.find((p) => `Patient/${p.id}` === claim.patient?.reference);
    const coverage = coverages.find((c) => c.beneficiary?.reference === claim.patient?.reference);
    return {
      id: claim.id!,
      identifier: claim.identifier?.[0]?.value ?? claim.id!,
      patientName: patient ? nameOf(patient) : 'Unknown',
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
export async function patientPortal(): Promise<{ patient?: PatientSummary; items: PortalItem[] }> {
  const patients = await listPatients();
  const patient = patients[0];
  if (!patient) return { patient: undefined, items: [] };
  const store = await getStore();
  const ref = `Patient/${patient.id}`;
  const firstName = patient.name.split(' ')[0];

  const [comms, appts, srs, cards] = await Promise.all([
    store.search<Communication>('Communication', { subject: ref }),
    store.search<Appointment>('Appointment', {}),
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
    if (!a.participant?.some((p) => p.actor?.reference === ref)) continue;
    items.push({
      at: a.meta?.lastUpdated ?? a.start ?? '',
      kind: 'visit',
      title: a.description ?? 'Visit booked for you',
      body: a.start
        ? `${new Date(a.start).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} at ${new Date(a.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} — no action needed, just show up.`
        : undefined,
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
    } else if (c.stage === 'denied' || c.stage === 'appealed') {
      items.push({
        at: c.updatedAt,
        kind: 'insurance_fight',
        title: "We're handling an insurance issue for you",
        body: `${c.payer} initially declined your ${c.procedure ?? 'claim'}${c.denialLabel ? ` (${c.denialLabel.toLowerCase()})` : ''}. ${firstName}, you don't need to do anything — we've already filed an appeal with supporting medical evidence.`,
      });
    }
  }

  return { patient, items: items.filter((i) => i.at).sort((a, b) => b.at.localeCompare(a.at)) };
}

/** Dollars recovered via approvals after appeal — the layman headline number. */
export async function moneyRecovered(): Promise<number> {
  const store = await getStore();
  const responses = await store.search<ClaimResponse>('ClaimResponse', {});
  return responses
    .filter((r) => r.outcome === 'complete')
    .reduce((s, r) => s + (r.payment?.amount?.value ?? 0), 0);
}

// ── Schedule ────────────────────────────────────────────────────────────────

export interface AppointmentRow {
  id: string;
  description: string;
  start?: string;
  status: string;
  patientName: string;
  bookedAt?: string;
}

export async function listAppointments(): Promise<AppointmentRow[]> {
  const store = await getStore();
  const [appts, patients] = await Promise.all([
    store.search<Appointment>('Appointment', {}),
    store.search<Patient>('Patient', {}),
  ]);
  return appts
    .map((a) => {
      const patientRef = a.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
      const patient = patients.find((p) => `Patient/${p.id}` === patientRef);
      return {
        id: a.id!,
        description: a.description ?? 'Visit',
        start: a.start,
        status: a.status ?? 'booked',
        patientName: patient ? nameOf(patient) : 'Unknown',
        bookedAt: a.meta?.lastUpdated,
      };
    })
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
}
