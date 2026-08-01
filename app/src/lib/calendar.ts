/**
 * Pure calendar math: timezone-aware instant mapping, grid construction, and
 * overlap layout. No React, no server-only — the client calendar and the
 * server-side appointment service both import from here, so the two never
 * disagree about which day an appointment falls on.
 */

export type CalendarView = 'month' | 'week' | 'day' | 'list';

// How each booking source reads in a sentence; bookedByLabel is the accessor.
const BOOKING_SOURCE_LABEL: Record<string, string> = {
  'discharge-agent': 'discharge agent',
  'care-gap-agent': 'care-gap agent',
  copilot: 'copilot',
  staff: 'front desk',
  'voice-agent': 'phone agent',
};

/** The label for a booking source, falling back to the raw code. */
export function bookedByLabel(source: string): string {
  return BOOKING_SOURCE_LABEL[source] ?? source;
}

/**
 * The client's contract for an appointment. `CalendarAppointment` from
 * appointments.server.ts satisfies this structurally, so the UI never has to
 * import a `server-only` module to get its types.
 */
export interface CalendarRow {
  id: string;
  handle: string;
  description: string;
  start?: string;
  end?: string;
  minutes?: number;
  status: string;
  patientId?: string;
  patientName: string;
  createdAt?: string;
  bookedBy: string;
  cancelledReason?: string;
}

export interface CalDay {
  date: Date;
  key: string;
  label: number;
  inMonth: boolean;
  isToday: boolean;
}

export interface CalEvent {
  id: string;
  handle: string;
  title: string;
  patientName: string;
  dayKey: string;
  startMin: number;
  endMin: number;
  status: string;
  bookedBy: string;
  isCancelled: boolean;
  isAgent: boolean;
  isPending: boolean;
  start?: string;
  end?: string;
}

export interface Placed {
  event: CalEvent;
  column: number;
  columns: number;
}

// ── Timezone-aware instant mapping ──────────────────────────────────────────

/** A zone's UTC offset in minutes at a given instant (DST-aware). */
export function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** Wall-clock date and minute-of-day that an instant reads as in the given zone. */
export function zonedReading(iso: string, timeZone: string): { dayKey: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  // hour12:false can render midnight as "24" in some ICU versions.
  const hour = Number(get('hour')) % 24;
  return {
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  };
}

/** The instant at which a zone's wall clock reads this day and minute-of-day. */
export function zonedIso(dayKey: string, minutes: number, timeZone: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  // Resolve twice: the first read can sit on the wrong side of a DST boundary.
  const corrected = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess - offsetMinutes(new Date(corrected), timeZone) * 60_000).toISOString();
}

/** Today's date in the given zone, as a YYYY-MM-DD key. */
export function todayKey(timeZone: string): string {
  return zonedReading(new Date().toISOString(), timeZone).dayKey;
}

/**
 * The same instant as zonedIso, written with the zone's own UTC offset rather
 * than a trailing Z — the form the copilot is told to emit, so the worked
 * example in its prompt matches the rule.
 */
export function zonedIsoWithOffset(dayKey: string, minutes: number, timeZone: string): string {
  const offset = offsetMinutes(new Date(zonedIso(dayKey, minutes, timeZone)), timeZone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${dayKey}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ── Day arithmetic (local Date objects, used only to build the grid) ────────

export function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

export function addMonths(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(1);
  copy.setMonth(copy.getMonth() + n);
  return copy;
}

/** Sunday-start week containing `d`. */
export function startOfWeek(d: Date): Date {
  return addDays(startOfDay(d), -startOfDay(d).getDay());
}

/**
 * Local YYYY-MM-DD. Must NOT use toISOString() — that is UTC and would file
 * evening appointments under the wrong day west of Greenwich.
 */
export function dayKeyOf(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse a YYYY-MM-DD key back into a local midnight Date. */
export function dateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// ── Grid construction ───────────────────────────────────────────────────────

function toCalDay(date: Date, month: number, today: string): CalDay {
  const key = dayKeyOf(date);
  return { date, key, label: date.getDate(), inMonth: date.getMonth() === month, isToday: key === today };
}

/** The 35 or 42 cells of a month grid, including the leading and trailing days. */
export function monthGridDays(anchor: Date, today: string): CalDay[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const weeks = Math.ceil((first.getDay() + new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => toCalDay(addDays(start, i), anchor.getMonth(), today));
}

export function weekDays(anchor: Date, today: string): CalDay[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => toCalDay(addDays(start, i), anchor.getMonth(), today));
}

export function singleDay(anchor: Date, today: string): CalDay[] {
  return [toCalDay(startOfDay(anchor), anchor.getMonth(), today)];
}

// ── Events ──────────────────────────────────────────────────────────────────

const AGENT_SOURCES = ['discharge-agent', 'care-gap-agent'];

/** Map store rows onto the grid, resolving each instant in the clinic's zone. */
export function toCalEvents(rows: CalendarRow[], timeZone: string, pendingIds?: ReadonlySet<string>): CalEvent[] {
  const events: CalEvent[] = [];
  for (const row of rows) {
    if (!row.start) continue;
    const { dayKey, minutes } = zonedReading(row.start, timeZone);
    const length = row.minutes ?? (row.end ? Math.round((Date.parse(row.end) - Date.parse(row.start)) / 60_000) : 30);
    events.push({
      id: row.id,
      handle: row.handle,
      title: row.description,
      patientName: row.patientName,
      dayKey,
      startMin: minutes,
      // Clamp to the day so a visit crossing midnight can't overflow the column.
      endMin: Math.min(minutes + Math.max(length, 15), 24 * 60),
      status: row.status,
      bookedBy: row.bookedBy,
      isCancelled: row.status === 'cancelled',
      isAgent: AGENT_SOURCES.includes(row.bookedBy),
      isPending: pendingIds?.has(row.id) ?? false,
      start: row.start,
      end: row.end,
    });
  }
  // Day first, then time: the agenda groups in document order, so sorting by
  // time-of-day alone would interleave days.
  return events.sort(
    (a, b) => a.dayKey.localeCompare(b.dayKey) || a.startMin - b.startMin || a.title.localeCompare(b.title),
  );
}

export function eventsForDay(events: CalEvent[], key: string): CalEvent[] {
  return events.filter((e) => e.dayKey === key);
}

/** Business window, widened so an out-of-hours visit can never be invisible. */
export function hourWindow(events: CalEvent[], min = 7 * 60, max = 19 * 60): { startMin: number; endMin: number } {
  let startMin = min;
  let endMin = max;
  for (const e of events) {
    startMin = Math.min(startMin, Math.floor(e.startMin / 60) * 60);
    endMin = Math.max(endMin, Math.ceil(e.endMin / 60) * 60);
  }
  return { startMin: Math.max(0, startMin), endMin: Math.min(24 * 60, Math.max(endMin, startMin + 60)) };
}

/**
 * Side-by-side columns for concurrent events. Every agent booking lands at
 * exactly 10:00, so a day routinely holds three overlapping visits and this
 * is what stops them painting on top of each other.
 */
export function layoutOverlaps(events: CalEvent[]): Placed[] {
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const placed: Placed[] = [];

  let cluster: CalEvent[] = [];
  let clusterEnd = -Infinity;

  const flush = (): void => {
    if (cluster.length === 0) return;
    const columnEnds: number[] = [];
    const assigned: Array<{ event: CalEvent; column: number }> = [];
    for (const event of cluster) {
      let column = columnEnds.findIndex((end) => end <= event.startMin);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(0);
      }
      columnEnds[column] = event.endMin;
      assigned.push({ event, column });
    }
    for (const a of assigned) placed.push({ ...a, columns: columnEnds.length });
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const event of sorted) {
    if (event.startMin >= clusterEnd) flush();
    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, event.endMin);
  }
  flush();
  return placed;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function snapMinutes(minutes: number, step = 15): number {
  return Math.max(0, Math.min(24 * 60 - step, Math.round(minutes / step) * step));
}

/** "10:00 AM" from a minute-of-day. */
export function fmtMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${display} ${suffix}` : `${display}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** The heading over the grid, e.g. "August 2026" or "Aug 9 – 15, 2026". */
export function fmtRangeTitle(view: CalendarView, anchor: Date): string {
  if (view === 'month' || view === 'list') {
    return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  if (view === 'day') {
    return anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }
  const start = startOfWeek(anchor);
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const left = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const right = end.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${left} – ${right}, ${end.getFullYear()}`;
}
