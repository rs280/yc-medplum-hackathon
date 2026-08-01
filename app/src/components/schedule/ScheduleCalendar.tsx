'use client';

import { animate } from 'animejs';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addDays,
  addMonths,
  dateFromKey,
  fmtRangeTitle,
  monthGridDays,
  singleDay,
  snapMinutes,
  startOfDay,
  todayKey as todayKeyFor,
  toCalEvents,
  weekDays,
  zonedIso,
  zonedReading,
  type CalendarRow,
  type CalendarView,
} from '@/lib/calendar';
import { resumeLiveRefresh, suspendLiveRefresh } from '@/lib/liveRefresh';
import { AgendaList } from './AgendaList';
import { CalendarPopover, type PatientOption, type PopoverState } from './CalendarPopover';
import { MonthGrid } from './MonthGrid';
import { PX_PER_MIN, TimeGrid } from './TimeGrid';

/**
 * Optimistic overlays, deliberately NOT React's useOptimistic: that state is
 * scoped to the transition that owns it, so a write resolving before the next
 * router.refresh() would visibly snap the event back to its old slot for up to
 * four seconds. These overlays are retired only once the server payload agrees.
 */
type Overlay =
  | { kind: 'create'; row: CalendarRow }
  | { kind: 'move'; id: string; start: string; end: string }
  | { kind: 'cancel'; id: string }
  | { kind: 'restore'; id: string };

function applyOverlays(rows: CalendarRow[], overlays: Overlay[]): CalendarRow[] {
  let out = rows;
  for (const o of overlays) {
    if (o.kind === 'create') {
      out = [...out, o.row];
      continue;
    }
    out = out.map((r) => {
      if (r.id !== o.id) return r;
      if (o.kind === 'move') return { ...r, start: o.start, end: o.end };
      return { ...r, status: o.kind === 'cancel' ? 'cancelled' : 'booked' };
    });
  }
  return out;
}

/**
 * The calendar controller: owns view, anchor, and every ephemeral piece of UI
 * state, and reads interaction intent off data attributes via one delegated
 * handler so the view components stay callback-free.
 *
 * IMPORTANT: the page re-renders every 4s (AutoRefresh) and again whenever the
 * copilot books something. Nothing here may be keyed on the data — a
 * data-derived `key` on this component, or a <Stagger> around the grid, would
 * remount or re-animate the whole calendar every four seconds. View state is
 * deliberately client-only so a refresh can never change what you are looking at.
 */

const VIEWS: Array<{ id: CalendarView; label: string }> = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
  { id: 'list', label: 'List' },
];

const FLASH_MS = 6000;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Where in the day a click landed. Month cells have no time axis, so they seed
 * 9:00; a time-grid column reads the minute off the pointer and snaps it.
 */
function minutesFromPointer(cell: HTMLElement, clientY: number): number {
  const grid = cell.closest<HTMLElement>('.cal-time');
  if (!grid || !cell.classList.contains('cal-col')) return 9 * 60;
  const windowStart = Number(grid.dataset.windowStart ?? 0);
  const offset = (clientY - cell.getBoundingClientRect().top) / PX_PER_MIN;
  return snapMinutes(windowStart + offset, 15);
}

interface DragState {
  id: string;
  x0: number;
  y0: number;
  active: boolean;
}

interface DropTarget {
  dayKey: string;
  /** Undefined in month view, where a move keeps the original time. */
  minutes?: number;
}

/** Resolve the day (and minute, in a time grid) under the pointer. */
function dropTargetAt(clientX: number, clientY: number): DropTarget | null {
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const cell = el?.closest<HTMLElement>('[data-day]');
  if (!cell?.dataset.day) return null;
  if (!cell.classList.contains('cal-col')) return { dayKey: cell.dataset.day };
  return { dayKey: cell.dataset.day, minutes: minutesFromPointer(cell, clientY) };
}

export interface ScheduleCalendarProps {
  appointments: CalendarRow[];
  patients: PatientOption[];
  timeZone: string;
}

export function ScheduleCalendar({ appointments, patients, timeZone }: ScheduleCalendarProps) {
  const [view, setView] = useState<CalendarView>('month');
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(() => new Set());
  const [nowMin, setNowMin] = useState<number | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState<DropTarget | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const seenIds = useRef<Set<string> | null>(null);
  const drag = useRef<DragState | null>(null);
  const router = useRouter();

  // Content signature, not array identity: every refresh hands us a new array
  // object, so memoising on `appointments` alone would recompute constantly.
  const signature = useMemo(
    () => appointments.map((a) => `${a.id}:${a.start}:${a.status}`).join('|'),
    [appointments],
  );

  const rows = useMemo(() => applyOverlays(appointments, overlays), [signature, overlays]); // eslint-disable-line react-hooks/exhaustive-deps
  const pendingIds = useMemo(
    () => new Set(overlays.map((o) => (o.kind === 'create' ? o.row.id : o.id))),
    [overlays],
  );

  const today = useMemo(() => todayKeyFor(timeZone), [timeZone]);
  const events = useMemo(() => toCalEvents(rows, timeZone, pendingIds), [rows, timeZone, pendingIds]);

  // Retire each overlay only once the server payload actually reflects it —
  // that gap is what would otherwise flicker on the next 4s refresh.
  useEffect(() => {
    setOverlays((prev) =>
      prev.filter((o) => {
        if (o.kind === 'create') return !appointments.some((r) => r.id === o.row.id);
        const row = appointments.find((r) => r.id === o.id);
        if (!row) return false;
        if (o.kind === 'move') return row.start !== o.start;
        if (o.kind === 'cancel') return row.status !== 'cancelled';
        return row.status === 'cancelled';
      }),
    );
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => {
    if (view === 'week') return weekDays(anchor, today);
    if (view === 'day') return singleDay(anchor, today);
    return monthGridDays(anchor, today);
  }, [view, anchor, today]);

  const visibleEvents = useMemo(() => {
    if (view === 'list') {
      // The list runs forward from the anchor month rather than clipping to a grid.
      const from = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-01`;
      return events.filter((e) => e.dayKey >= from);
    }
    const keys = new Set(days.map((d) => d.key));
    return events.filter((e) => keys.has(e.dayKey));
  }, [events, days, view, anchor]);

  // Keep the now-line honest without re-rendering more than once a minute.
  useEffect(() => {
    const tick = (): void => setNowMin(zonedReading(new Date().toISOString(), timeZone).minutes);
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [timeZone]);

  // Newly-arrived appointments glow, and the calendar walks itself to them —
  // this is what makes an agent booking read as "streamed in" on a projector.
  useEffect(() => {
    const ids = new Set(appointments.map((a) => a.id));
    if (seenIds.current === null) {
      seenIds.current = ids;
      return;
    }
    const fresh = [...ids].filter((id) => !seenIds.current!.has(id));
    seenIds.current = ids;
    if (fresh.length === 0) return;

    setFlashIds(new Set(fresh));
    const arrival = appointments.find((a) => a.id === fresh[0] && a.start);
    if (arrival?.start) {
      const { dayKey } = zonedReading(arrival.start, timeZone);
      const onScreen = days.some((d) => d.key === dayKey);
      if (!onScreen) setAnchor(startOfDay(dateFromKey(dayKey)));
    }
    const timer = setTimeout(() => setFlashIds(new Set()), FLASH_MS);
    return () => clearTimeout(timer);
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animate only the arrivals, in the same idiom as components/anim.tsx.
  useEffect(() => {
    if (flashIds.size === 0 || reducedMotion()) return;
    const nodes = [...flashIds]
      .map((id) => rootRef.current?.querySelector<HTMLElement>(`[data-appt-id="${id}"]`))
      .filter((n): n is HTMLElement => Boolean(n));
    if (nodes.length === 0) return;
    animate(nodes, { opacity: [0, 1], scale: [0.94, 1], duration: 420, ease: 'out(3)' });
  }, [flashIds, view, anchor]);

  const step = useCallback(
    (direction: -1 | 1) => {
      setAnchor((current) => {
        if (view === 'month' || view === 'list') return addMonths(current, direction);
        return addDays(current, direction * (view === 'week' ? 7 : 1));
      });
    },
    [view],
  );

  /** Every write goes through the one HTTP boundary; overlays hide the latency. */
  const mutate = useCallback(
    async (body: Record<string, unknown>, optimistic: Overlay): Promise<void> => {
      setBusy(true);
      setError(undefined);
      setOverlays((prev) => [...prev, optimistic]);
      try {
        const res = await fetch('/api/appointments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, source: 'staff' }),
        });
        const data = await res.json();
        if (!data.ok) {
          setOverlays((prev) => prev.filter((o) => o !== optimistic));
          setError(data.error?.message ?? 'That did not work.');
          return;
        }
        // A create overlay carries a synthetic id the server will never return,
        // so swap in the real row — otherwise it could never be retired and the
        // appointment would render twice until the page was reloaded.
        if (optimistic.kind === 'create' && data.appointment) {
          setOverlays((prev) =>
            prev.map((o) => (o === optimistic ? { kind: 'create', row: data.appointment } : o)),
          );
        }
        setPopover(null);
        router.refresh();
      } catch {
        setOverlays((prev) => prev.filter((o) => o !== optimistic));
        setError('Could not reach the server.');
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  // ── Drag to reschedule ────────────────────────────────────────────────────
  // Hand-rolled pointer events: capture on the ROOT so the handlers survive the
  // dragged element re-rendering, and resolve the drop target with
  // elementFromPoint so it stays correct after any re-render or scroll.

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pill = (event.target as HTMLElement).closest<HTMLElement>('[data-appt-id]');
    if (!pill?.dataset.apptId || event.button !== 0) return;
    drag.current = { id: pill.dataset.apptId, x0: event.clientX, y0: event.clientY, active: false };
    rootRef.current?.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    // A 5px threshold is what separates a click from a drag.
    if (!state.active) {
      if (Math.hypot(event.clientX - state.x0, event.clientY - state.y0) < 5) return;
      state.active = true;
      suspendLiveRefresh();
      setDragId(state.id);
    }
    event.preventDefault();
    setDropPreview(dropTargetAt(event.clientX, event.clientY));
  }, []);

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
      const state = drag.current;
      drag.current = null;
      if (rootRef.current?.hasPointerCapture(event.pointerId)) {
        rootRef.current.releasePointerCapture(event.pointerId);
      }
      if (!state) return;

      if (!state.active) {
        // Never crossed the threshold — this was a click on the event.
        setError(undefined);
        setPopover({ kind: 'detail', x: event.clientX, y: event.clientY, apptId: state.id });
        return;
      }

      resumeLiveRefresh();
      const target = dropPreview;
      setDragId(null);
      setDropPreview(null);
      if (!commit || !target) return;

      const row = rows.find((r) => r.id === state.id);
      if (!row) return;
      const minutes = row.minutes ?? 30;
      // Month cells have no time axis, so a whole-day move keeps the time.
      const startMinutes = target.minutes ?? (row.start ? zonedReading(row.start, timeZone).minutes : 9 * 60);
      const startIso = zonedIso(target.dayKey, startMinutes, timeZone);
      if (row.start === startIso) return;

      void mutate(
        { action: 'reschedule', id: row.id, startIso, minutes },
        { kind: 'move', id: row.id, start: startIso, end: new Date(Date.parse(startIso) + minutes * 60_000).toISOString() },
      );
    },
    [dropPreview, rows, timeZone, mutate],
  );

  // One delegated handler: the views render data attributes, never callbacks.
  const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;

    const more = target.closest<HTMLElement>('[data-more]');
    if (more?.dataset.more) {
      setAnchor(startOfDay(dateFromKey(more.dataset.more)));
      setView('day');
      return;
    }

    // Events open their popover from the pointer-up path, so a drag that ends
    // over another day cannot also open a create form behind it.
    if (target.closest('[data-appt-id]')) return;

    const cell = target.closest<HTMLElement>('[data-day]');
    if (!cell?.dataset.day) return;
    setError(undefined);
    setPopover({
      kind: 'create',
      x: event.clientX,
      y: event.clientY,
      dayKey: cell.dataset.day,
      minutes: minutesFromPointer(cell, event.clientY),
    });
  }, []);

  const newCount = flashIds.size;

  return (
    <div
      className={`cal-root${dragId ? ' is-dragging-any' : ''}`}
      ref={rootRef}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
    >
      <div className="cal-bar">
        <div className="cal-nav">
          <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label="Previous">
            <ChevronLeft size={16} strokeWidth={2.2} aria-hidden />
          </button>
          <button type="button" className="icon-btn" onClick={() => step(1)} aria-label="Next">
            <ChevronRight size={16} strokeWidth={2.2} aria-hidden />
          </button>
          <h2 className="cal-title">{fmtRangeTitle(view, anchor)}</h2>
          <button type="button" className="switch-chip" onClick={() => setAnchor(startOfDay(new Date()))}>
            Today
          </button>
          {newCount > 0 && (
            <span className="chip chip-live cal-new-count">
              {newCount} new {newCount === 1 ? 'booking' : 'bookings'}
            </span>
          )}
        </div>
        <div className="cal-views" role="tablist" aria-label="Calendar view">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={`switch-chip${view === v.id ? ' active' : ''}`}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'list' ? (
        <AgendaList
          events={visibleEvents}
          flashIds={flashIds}
          signal={`${view}:${anchor.getFullYear()}-${anchor.getMonth()}`}
        />
      ) : (
        <div className="card cal-card">
          {view === 'month' ? (
            <MonthGrid
              days={days}
              events={visibleEvents}
              flashIds={flashIds}
              dragId={dragId}
              dropKey={dropPreview?.dayKey ?? null}
            />
          ) : (
            <TimeGrid
              days={days}
              events={visibleEvents}
              flashIds={flashIds}
              dragId={dragId}
              dropKey={dropPreview?.dayKey ?? null}
              nowMin={nowMin}
              todayKey={today}
            />
          )}
          {visibleEvents.length === 0 && (
            <p className="empty cal-empty">
              <CalendarDays size={15} strokeWidth={1.8} aria-hidden /> Nothing booked in this range. Click any day to
              add one.
            </p>
          )}
        </div>
      )}

      {popover && (
        <CalendarPopover
          state={popover}
          patients={patients}
          timeZone={timeZone}
          appointment={popover.kind === 'detail' ? rows.find((r) => r.id === popover.apptId) : undefined}
          busy={busy}
          error={error}
          onClose={() => {
            setPopover(null);
            setError(undefined);
          }}
          onCreate={({ patientId, description, dayKey, time, minutes }) => {
            const startIso = zonedIso(dayKey, timeToMinutes(time), timeZone);
            void mutate(
              { action: 'book', patientId, description: description || undefined, startIso, minutes },
              {
                kind: 'create',
                row: {
                  id: `pending-${dayKey}-${time}`,
                  handle: 'APT-••••',
                  description: description || 'New appointment',
                  start: startIso,
                  end: new Date(Date.parse(startIso) + minutes * 60_000).toISOString(),
                  minutes,
                  status: 'booked',
                  patientId,
                  patientName: patients.find((p) => p.id === patientId)?.name ?? 'Patient',
                  bookedBy: 'staff',
                },
              },
            );
          }}
          onCancelVisit={(id, reason) =>
            void mutate({ action: 'cancel', id, reason: reason || undefined }, { kind: 'cancel', id })
          }
          onRestore={(id) => void mutate({ action: 'restore', id }, { kind: 'restore', id })}
          onMove={(id, dayKey, time) => {
            const startIso = zonedIso(dayKey, timeToMinutes(time), timeZone);
            const current = rows.find((r) => r.id === id);
            const minutes = current?.minutes ?? 30;
            void mutate(
              { action: 'reschedule', id, startIso, minutes },
              {
                kind: 'move',
                id,
                start: startIso,
                end: new Date(Date.parse(startIso) + minutes * 60_000).toISOString(),
              },
            );
          }}
        />
      )}
    </div>
  );
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour || 0) * 60 + (minute || 0);
}
