import 'server-only';
import type { Appointment, Meta, Patient, ServiceRequest } from '@medplum/fhirtypes';
import { getStore, writeAudit, type FhirStore } from './medplum.server';
import { todayKey, zonedIso } from './calendar';
import { findPatientByName, patientDisplayName, shortDisplayName } from './patients.server';

/**
 * THE clinic calendar: every appointment read and every appointment write in
 * the app goes through this module — the Schedule page, the copilot tools, the
 * pipeline's act() step, the /api/appointments boundary, and any future voice
 * agent. Cancelling is a FHIR soft cancel (status -> 'cancelled'), so nothing
 * is ever deleted and the calendar, the patient timeline and the AuditEvent
 * trail all keep the full history.
 *
 * Search note: Appointment is ALWAYS fetched as search('Appointment', {}) and
 * filtered in JS. The memory store's matches() understands a fixed param list
 * and silently returns [] for anything else, so a `date=ge...` search would
 * blank the calendar with no error at all. This is the only search<Appointment>
 * call in the codebase — keep it that way.
 */

/** Times are booked and displayed in the clinic's zone, not the server's. */
export const CLINIC_TIME_ZONE = process.env.CLINIC_TIME_ZONE ?? 'America/Los_Angeles';

const BOOKING_SOURCE_SYSTEM = 'https://autonomous-backoffice.dev/booking-source';
const CANCELLED_BY_SYSTEM = 'https://autonomous-backoffice.dev/cancelled-by';

export type BookingSource = 'discharge-agent' | 'care-gap-agent' | 'copilot' | 'staff' | 'voice-agent';

const BOOKING_SOURCES: readonly BookingSource[] = [
  'discharge-agent',
  'care-gap-agent',
  'copilot',
  'staff',
  'voice-agent',
];

export interface CalendarAppointment {
  id: string;
  /** "APT-4F2A" — the handle a model or a human uses to name this visit. */
  handle: string;
  description: string;
  start?: string;
  end?: string;
  minutes?: number;
  status: Appointment['status'];
  patientId?: string;
  patientName: string;
  patientShortName: string;
  /** Appointment.created — when it was BOOKED, never rewritten by later edits. */
  createdAt?: string;
  updatedAt?: string;
  bookedBy: BookingSource;
  cancelledBy?: BookingSource;
  cancelledReason?: string;
  /** "ServiceRequest/xyz" for care-gap bookings — the order this visit closes. */
  basedOnRef?: string;
}

/** Never guesses: an ambiguous reference comes back as `many` so the caller can ask. */
export type AppointmentMatch =
  | { kind: 'one'; appointment: Appointment }
  | { kind: 'none' }
  | { kind: 'many'; candidates: CalendarAppointment[] };

export interface BookResult {
  appointment: CalendarAppointment;
  /** One plain sentence in the clinic zone — safe to speak aloud. */
  summary: string;
  warning?: string;
}

/** One error type so the route handler and the copilot dispatcher each need ONE mapping. */
export class AppointmentError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'ambiguous' | 'conflict',
    message: string,
    readonly candidates?: CalendarAppointment[],
  ) {
    super(message);
    this.name = 'AppointmentError';
  }
}

// ── Handles, statuses, tags ─────────────────────────────────────────────────

/** Short stable handle derived from the FHIR id — no storage, safe for an LLM to say. */
export function appointmentHandle(id: string): string {
  return `APT-${id.replace(/-/g, '').slice(-4).toUpperCase()}`;
}

/** True for statuses that still occupy a slot on the calendar. */
export function isActiveStatus(status: Appointment['status']): boolean {
  return ['proposed', 'pending', 'booked', 'arrived', 'checked-in', 'waitlist'].includes(status);
}

/** Set (replacing) one tag by system — every write re-asserts it so a spread can't drop it. */
export function withTag(meta: Meta | undefined, system: string, code: BookingSource): Meta {
  const tag = (meta?.tag ?? []).filter((t) => t.system !== system);
  return { ...meta, tag: [...tag, { system, code }] };
}

function readTag(appt: Appointment, system: string): BookingSource | undefined {
  const code = appt.meta?.tag?.find((t) => t.system === system)?.code;
  // Medplum may strip meta.tag depending on project settings; identifier is the fallback.
  const fallback = appt.identifier?.find((i) => i.system === system)?.value;
  const value = code ?? fallback;
  return BOOKING_SOURCES.find((s) => s === value);
}

function readBookingSource(appt: Appointment): BookingSource {
  const tagged = readTag(appt, BOOKING_SOURCE_SYSTEM);
  if (tagged) return tagged;
  // Legacy rows booked before provenance tagging: infer from the agent's own wording.
  const description = appt.description ?? '';
  if (/^Post-discharge/.test(description)) return 'discharge-agent';
  if (/^Care-gap/.test(description)) return 'care-gap-agent';
  return 'staff';
}

// ── Clinic-timezone arithmetic (math itself lives in the shared calendar module) ──

/** The clinic-local calendar date N days from today, as a YYYY-MM-DD key. */
export function clinicDayKey(daysFromNow: number): string {
  const [year, month, day] = todayKey(CLINIC_TIME_ZONE).split('-').map(Number);
  // Date.UTC normalises day overflow, so "day + 30" rolls the month for us.
  return new Date(Date.UTC(year, month - 1, day + daysFromNow)).toISOString().slice(0, 10);
}

/** A clinic-local slot N days from today, e.g. clinicSlot(1) = tomorrow at 10:00. */
export function clinicSlot(daysFromNow: number, hour = 10, minute = 0): string {
  return zonedIso(clinicDayKey(daysFromNow), hour * 60 + minute, CLINIC_TIME_ZONE);
}

function fmtPart(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: CLINIC_TIME_ZONE, ...opts }).format(new Date(iso));
}

/** One human slot string ("Tue Aug 11, 10:00 AM – 11:00 AM"), always in the clinic zone. */
export function formatSlot(startIso?: string, endIso?: string): string {
  if (!startIso) return 'Unscheduled';
  const day = fmtPart(startIso, { weekday: 'short', month: 'short', day: 'numeric' });
  const start = fmtPart(startIso, { hour: 'numeric', minute: '2-digit' });
  if (!endIso) return `${day}, ${start}`;
  return `${day}, ${start} – ${fmtPart(endIso, { hour: 'numeric', minute: '2-digit' })}`;
}

/** One line per candidate with its handle — the disambiguation text for a model or a user. */
export function describeCandidates(candidates: CalendarAppointment[]): string {
  return candidates
    .map((c) => `${c.handle} ${formatSlot(c.start, c.end)}, ${c.description}`)
    .join('; ');
}

// ── Reads ───────────────────────────────────────────────────────────────────

function toCalendarAppointment(appt: Appointment, byRef: Map<string, Patient>): CalendarAppointment {
  const actor = appt.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor;
  const patient = actor?.reference ? byRef.get(actor.reference) : undefined;
  const minutes =
    appt.minutesDuration ??
    (appt.start && appt.end ? Math.round((Date.parse(appt.end) - Date.parse(appt.start)) / 60_000) : undefined);

  return {
    id: appt.id!,
    handle: appointmentHandle(appt.id!),
    description: appt.description ?? 'Visit',
    start: appt.start,
    end: appt.end,
    minutes,
    status: appt.status,
    patientId: patient?.id ?? actor?.reference?.split('/')[1],
    patientName: patient ? patientDisplayName(patient) : actor?.display ?? 'Unknown patient',
    patientShortName: patient ? shortDisplayName(patient) : actor?.display ?? 'Unknown patient',
    createdAt: appt.created ?? appt.meta?.lastUpdated,
    updatedAt: appt.meta?.lastUpdated,
    bookedBy: readBookingSource(appt),
    cancelledBy: readTag(appt, CANCELLED_BY_SYSTEM),
    cancelledReason: appt.cancelationReason?.text,
    basedOnRef: appt.basedOn?.find((r) => r.reference?.startsWith('ServiceRequest/'))?.reference,
  };
}

/** Everything the calendar needs, joined to its patient and sorted by start time. */
export async function listCalendar(
  opts: {
    fromIso?: string;
    toIso?: string;
    patientId?: string;
    patientName?: string;
    includeCancelled?: boolean;
    store?: FhirStore;
  } = {},
): Promise<CalendarAppointment[]> {
  const store = opts.store ?? (await getStore());
  const [appts, patients] = await Promise.all([
    store.search<Appointment>('Appointment', {}),
    store.search<Patient>('Patient', {}),
  ]);
  const byRef = new Map(patients.map((p) => [`Patient/${p.id}`, p]));

  let rows = appts.filter((a) => a.id).map((a) => toCalendarAppointment(a, byRef));
  if (!opts.includeCancelled) rows = rows.filter((r) => r.status !== 'cancelled');
  if (opts.patientId) rows = rows.filter((r) => r.patientId === opts.patientId);
  if (opts.patientName) {
    const q = opts.patientName.trim().toLowerCase();
    rows = rows.filter((r) => r.patientName.toLowerCase().includes(q));
  }
  // A window excludes unscheduled rows by definition — they belong to no day.
  if (opts.fromIso) rows = rows.filter((r) => r.start !== undefined && r.start >= opts.fromIso!);
  if (opts.toIso) rows = rows.filter((r) => r.start !== undefined && r.start < opts.toIso!);

  return rows.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
}

// ── Writes ──────────────────────────────────────────────────────────────────

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Push a preferred start forward in 30-minute steps until that patient is free. */
export function nextFreeSlot(
  existing: CalendarAppointment[],
  preferredIso: string,
  minutes: number,
  patientId?: string,
): string {
  if (!patientId) return preferredIso;
  const busy = existing.filter((r) => r.patientId === patientId && isActiveStatus(r.status) && r.start);
  let start = Date.parse(preferredIso);
  // Bounded so a pathologically full day can never spin: 16 steps = 8 hours.
  for (let step = 0; step < 16; step++) {
    const end = start + minutes * 60_000;
    const clash = busy.some((r) => {
      const s = Date.parse(r.start!);
      return overlaps(start, end, s, s + (r.minutes ?? 30) * 60_000);
    });
    if (!clash) break;
    start += 30 * 60_000;
  }
  return new Date(start).toISOString();
}

/** The ONE place an Appointment is created — copilot, staff UI and both pipeline agents call this. */
export async function bookAppointment(opts: {
  patientId?: string;
  patientRef?: string;
  patientName?: string;
  description?: string;
  startIso?: string;
  minutes?: number;
  source?: BookingSource;
  basedOnRef?: string;
  /** Agents shift to the next free slot instead of erroring on a same-patient clash. */
  allowStackedSlot?: boolean;
  store?: FhirStore;
}): Promise<BookResult> {
  const store = opts.store ?? (await getStore());
  const source = opts.source ?? 'staff';
  const minutes = opts.minutes && opts.minutes > 0 ? Math.round(opts.minutes) : 30;

  const patient = await resolvePatient(store, opts);
  const patientRef = `Patient/${patient.id}`;

  let start = opts.startIso ? new Date(opts.startIso) : new Date(NaN);
  if (Number.isNaN(start.getTime())) start = new Date(clinicSlot(1, 10));

  const existing = await listCalendar({ store });
  const preferred = start.toISOString();
  let startIso = preferred;
  let warning: string | undefined;

  const clash = existing.find((r) => {
    if (r.patientId !== patient.id || !r.start || !isActiveStatus(r.status)) return false;
    const s = Date.parse(r.start);
    return overlaps(
      Date.parse(preferred),
      Date.parse(preferred) + minutes * 60_000,
      s,
      s + (r.minutes ?? 30) * 60_000,
    );
  });
  if (clash) {
    if (!opts.allowStackedSlot) {
      throw new AppointmentError(
        'conflict',
        `${patientDisplayName(patient)} already has "${clash.description}" at ${formatSlot(clash.start, clash.end)} (${clash.handle}).`,
        [clash],
      );
    }
    startIso = nextFreeSlot(existing, preferred, minutes, patient.id);
    if (startIso !== preferred) warning = `Moved to ${formatSlot(startIso)} — the patient was already booked at that time.`;
  }

  const endIso = new Date(Date.parse(startIso) + minutes * 60_000).toISOString();
  const created = await store.create<Appointment>({
    resourceType: 'Appointment',
    status: 'booked',
    description: opts.description ?? 'New patient check-up',
    created: new Date().toISOString(),
    start: startIso,
    end: endIso,
    minutesDuration: minutes,
    basedOn: opts.basedOnRef ? [{ reference: opts.basedOnRef }] : undefined,
    participant: [{ actor: { reference: patientRef, display: patientDisplayName(patient) }, status: 'accepted' }],
    meta: withTag(undefined, BOOKING_SOURCE_SYSTEM, source),
    identifier: [{ system: BOOKING_SOURCE_SYSTEM, value: source }],
  });

  const byRef = new Map([[patientRef, patient]]);
  const row = toCalendarAppointment(created, byRef);
  return {
    appointment: row,
    summary: `Booked "${row.description}" for ${row.patientName} on ${formatSlot(row.start, row.end)} (${row.handle}).`,
    warning,
  };
}

/** Hydrate one stored Appointment into a calendar row, resolving its patient. */
async function rowFor(appt: Appointment, db: FhirStore): Promise<CalendarAppointment> {
  const ref = appt.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
  const id = ref?.split('/')[1];
  const patient = id ? await db.read<Patient>('Patient', id) : undefined;
  return toCalendarAppointment(appt, patient && ref ? new Map([[ref, patient]]) : new Map());
}

/** Find one appointment from a handle, a FHIR id, or a patient (+time) — never guesses. */
export async function resolveAppointment(
  ref: { handle?: string; id?: string; patientName?: string; startIso?: string },
  store?: FhirStore,
): Promise<AppointmentMatch> {
  const db = store ?? (await getStore());
  const rows = await listCalendar({ includeCancelled: true, store: db });

  const one = async (row: CalendarAppointment): Promise<AppointmentMatch> => {
    const appt = await db.read<Appointment>('Appointment', row.id);
    return appt ? { kind: 'one', appointment: appt } : { kind: 'none' };
  };
  const settle = async (matches: CalendarAppointment[]): Promise<AppointmentMatch> => {
    if (matches.length === 1) return one(matches[0]);
    return matches.length > 1 ? { kind: 'many', candidates: matches } : { kind: 'none' };
  };

  if (ref.id) {
    const id = ref.id.replace(/^Appointment\//, '');
    const row = rows.find((r) => r.id === id);
    return row ? one(row) : { kind: 'none' };
  }
  if (ref.handle) {
    // A 4-char handle can in principle collide; ask rather than pick.
    const handle = ref.handle.trim().toUpperCase();
    return settle(rows.filter((r) => r.handle === handle));
  }
  if (ref.patientName) {
    const q = ref.patientName.trim().toLowerCase();
    let matches = rows.filter((r) => r.patientName.toLowerCase().includes(q) && isActiveStatus(r.status));
    if (ref.startIso) {
      const target = Date.parse(ref.startIso);
      const near = matches.filter((r) => r.start && Math.abs(Date.parse(r.start) - target) <= 90 * 60_000);
      if (near.length > 0) matches = near;
    }
    return settle(matches);
  }
  return { kind: 'none' };
}

async function requireOne(
  ref: { handle?: string; id?: string; patientName?: string; startIso?: string },
  db: FhirStore,
  verb: string,
): Promise<Appointment> {
  const match = await resolveAppointment(ref, db);
  if (match.kind === 'one') return match.appointment;
  if (match.kind === 'many') {
    throw new AppointmentError(
      'ambiguous',
      `More than one visit matches. Which one? ${describeCandidates(match.candidates)}. Call ${verb} again with the handle.`,
      match.candidates,
    );
  }
  throw new AppointmentError('not_found', `No matching appointment — call list_appointments for the handle.`);
}

/**
 * A cancelled care-gap visit reopens the screening it was booked to close, so
 * the record never claims a screening happened that will not.
 *
 * Safe against the pipeline: a ServiceRequest?status=active subscription does
 * exist, but parseIntent only wakes the prior-auth agent for CPTs in
 * PRIOR_AUTH_CODES (the seeded care gap is 77067, which is not one), and the
 * Task-by-focus check in pipeline.ts blocks a rerun even if it were.
 */
async function setCareGapStatus(
  db: FhirStore,
  basedOnRef: string | undefined,
  status: 'active' | 'completed',
): Promise<boolean> {
  if (!basedOnRef?.startsWith('ServiceRequest/')) return false;
  try {
    const sr = await db.read<ServiceRequest>('ServiceRequest', basedOnRef.split('/')[1]);
    if (!sr || sr.status === status) return false;
    await db.update<ServiceRequest>({ ...sr, status });
    return true;
  } catch (err) {
    console.warn('[appointments] care gap status change failed:', err);
    return false;
  }
}

/** FHIR soft cancel: status -> 'cancelled' with a reason. Nothing is deleted. */
export async function cancelAppointment(opts: {
  handle?: string;
  id?: string;
  patientName?: string;
  reason?: string;
  by?: BookingSource;
  store?: FhirStore;
}): Promise<BookResult> {
  const db = opts.store ?? (await getStore());
  const appt = await requireOne(opts, db, 'cancel_appointment');
  const by = opts.by ?? 'staff';
  const reason = opts.reason?.trim() || 'Cancelled at the front desk';

  if (appt.status === 'cancelled') {
    const already = await rowFor(appt, db);
    return { appointment: already, summary: `${already.handle} was already cancelled.` };
  }

  const updated = await db.update<Appointment>({
    ...appt,
    status: 'cancelled',
    cancelationReason: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/appointmentcancellationreason', code: 'oth' }],
      text: reason,
    },
    meta: withTag(appt.meta, CANCELLED_BY_SYSTEM, by),
  });
  const row = await rowFor(updated, db);
  // Cancel first, reopen the gap second: the calendar is what the user is
  // looking at, so a ServiceRequest failure must not fail the cancel.
  const reopened = await setCareGapStatus(db, row.basedOnRef, 'active');

  await writeAudit(db, {
    subtype: 'appointment-cancel',
    description:
      `${row.handle} "${row.description}" for ${row.patientName} on ${formatSlot(row.start, row.end)} ` +
      `cancelled by ${by} — ${reason}${row.basedOnRef && !reopened ? ' (care gap could not be reopened)' : ''}`,
    entities: [`Appointment/${updated.id}`, row.patientId ? `Patient/${row.patientId}` : '', row.basedOnRef ?? ''].filter(
      Boolean,
    ),
  });

  return {
    appointment: row,
    summary:
      `Cancelled ${row.handle} — "${row.description}" for ${row.patientName} on ${formatSlot(row.start, row.end)}. ` +
      `It stays on the calendar marked cancelled${reopened ? ', and the overdue screening is open again' : ''}.`,
  };
}

/** Undo a cancel — back to 'booked', reason cleared, care gap re-closed. */
export async function restoreAppointment(opts: {
  handle?: string;
  id?: string;
  by?: BookingSource;
  store?: FhirStore;
}): Promise<BookResult> {
  const db = opts.store ?? (await getStore());
  const appt = await requireOne(opts, db, 'restore');
  const by = opts.by ?? 'staff';

  const { cancelationReason: _dropped, ...rest } = appt;
  const updated = await db.update<Appointment>({
    ...rest,
    status: 'booked',
    meta: { ...appt.meta, tag: (appt.meta?.tag ?? []).filter((t) => t.system !== CANCELLED_BY_SYSTEM) },
  });
  const row = await rowFor(updated, db);
  await setCareGapStatus(db, row.basedOnRef, 'completed');

  await writeAudit(db, {
    subtype: 'appointment-restore',
    description: `${row.handle} "${row.description}" restored to booked by ${by}`,
    entities: [`Appointment/${updated.id}`],
  });
  return {
    appointment: row,
    summary: `Restored ${row.handle} — "${row.description}" is booked again for ${formatSlot(row.start, row.end)}.`,
  };
}

/** Move a visit to a new slot, keeping its identity and its provenance. */
export async function rescheduleAppointment(opts: {
  handle?: string;
  id?: string;
  patientName?: string;
  startIso: string;
  minutes?: number;
  by?: BookingSource;
  store?: FhirStore;
}): Promise<BookResult> {
  const db = opts.store ?? (await getStore());
  const start = new Date(opts.startIso);
  if (Number.isNaN(start.getTime())) {
    throw new AppointmentError('invalid_input', `'${opts.startIso}' is not a valid date and time.`);
  }
  const appt = await requireOne(opts, db, 'reschedule_appointment');
  const before = await rowFor(appt, db);
  const minutes = opts.minutes && opts.minutes > 0 ? Math.round(opts.minutes) : before.minutes ?? 30;

  const updated = await db.update<Appointment>({
    ...appt,
    status: appt.status === 'cancelled' ? 'booked' : appt.status,
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * 60_000).toISOString(),
    minutesDuration: minutes,
  });
  const row = await rowFor(updated, db);

  await writeAudit(db, {
    subtype: 'appointment-reschedule',
    description: `${row.handle} moved from ${formatSlot(before.start, before.end)} to ${formatSlot(row.start, row.end)} by ${opts.by ?? 'staff'}`,
    entities: [`Appointment/${updated.id}`],
  });
  return {
    appointment: row,
    summary: `Moved ${row.handle} — "${row.description}" for ${row.patientName} is now ${formatSlot(row.start, row.end)}.`,
  };
}

/** Checkout: mark the patient's next booked visit fulfilled and leave an audit trail. */
export async function fulfilNextBooked(
  patientRef: string,
  store?: FhirStore,
): Promise<CalendarAppointment | undefined> {
  const db = store ?? (await getStore());
  const patientId = patientRef.split('/')[1];
  const next = (await listCalendar({ patientId, store: db })).find((a) => a.status === 'booked');
  if (!next) return undefined;

  const booked = await db.read<Appointment>('Appointment', next.id);
  if (!booked) return undefined;
  const updated = await db.update<Appointment>({ ...booked, status: 'fulfilled' });
  const row = toCalendarAppointment(updated, new Map());
  await writeAudit(db, {
    subtype: 'appointment-fulfilled',
    description: `${row.handle} "${row.description}" marked fulfilled at checkout`,
    entities: [`Appointment/${updated.id}`, patientRef],
  });
  return row;
}

async function resolvePatient(
  store: FhirStore,
  opts: { patientId?: string; patientRef?: string; patientName?: string },
): Promise<Patient> {
  const id = opts.patientId ?? opts.patientRef?.split('/')[1];
  if (id) {
    const found = await store.read<Patient>('Patient', id);
    if (found) return found;
    throw new AppointmentError('not_found', `No patient with id '${id}'.`);
  }
  if (opts.patientName) {
    const found = await findPatientByName(store, opts.patientName);
    if (found) return found;
    throw new AppointmentError('not_found', `No patient named '${opts.patientName}' — register them first.`);
  }
  throw new AppointmentError('invalid_input', 'A patient is required to book a visit.');
}
