'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { bookedByLabel, fmtMinutes, zonedReading, type CalendarRow } from '@/lib/calendar';

/**
 * The floating editor: a create form on an empty slot, a detail panel on an
 * existing visit. Rendered from client state only, so the page's 4s refresh
 * cannot close it or steal focus from a half-typed form.
 */

export type PopoverState =
  | { kind: 'create'; x: number; y: number; dayKey: string; minutes: number }
  | { kind: 'detail'; x: number; y: number; apptId: string };

export interface PatientOption {
  id: string;
  name: string;
}

export interface CalendarPopoverProps {
  state: PopoverState;
  patients: PatientOption[];
  appointment?: CalendarRow;
  /** Reading and writing both happen in the clinic's zone, never the browser's. */
  timeZone: string;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onCreate: (input: { patientId: string; description: string; dayKey: string; time: string; minutes: number }) => void;
  onCancelVisit: (id: string, reason: string) => void;
  onRestore: (id: string) => void;
  onMove: (id: string, dayKey: string, time: string) => void;
}

const DURATIONS = [15, 30, 45, 60];

function timeValue(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}


export function CalendarPopover(props: CalendarPopoverProps) {
  const { state, busy, error, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const firstField = useRef<HTMLSelectElement | HTMLInputElement | null>(null);

  // Focus the first field on open and restore focus to the trigger on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    firstField.current?.focus();
    return () => previous?.focus?.();
  }, [state.kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !ref.current) return;
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'button, select, input, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Fixed positioning: .content scrolls, so an absolute layer would be clipped.
  const style: React.CSSProperties = {
    left: Math.max(12, Math.min(state.x, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 312)),
    top: Math.max(12, Math.min(state.y, (typeof window === 'undefined' ? 800 : window.innerHeight) - 330)),
  };

  return (
    <>
      <div className="cal-scrim" onClick={onClose} aria-hidden />
      <div className="cal-pop" ref={ref} style={style} role="dialog" aria-modal="true" aria-label="Appointment">
        {state.kind === 'create' ? (
          <CreateForm {...props} state={state} firstField={firstField} />
        ) : (
          <DetailPanel {...props} firstField={firstField} />
        )}
        {error && <p className="cal-err">{error}</p>}
        {busy && <p className="cal-pop-busy">Saving…</p>}
      </div>
    </>
  );
}

function CreateForm({
  state,
  patients,
  busy,
  onClose,
  onCreate,
  firstField,
}: CalendarPopoverProps & {
  state: Extract<PopoverState, { kind: 'create' }>;
  firstField: React.MutableRefObject<HTMLSelectElement | HTMLInputElement | null>;
}) {
  const [patientId, setPatientId] = useState(patients[0]?.id ?? '');
  const [description, setDescription] = useState('');
  const [dayKey, setDayKey] = useState(state.dayKey);
  const [time, setTime] = useState(timeValue(state.minutes));
  const [minutes, setMinutes] = useState(30);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (patientId) onCreate({ patientId, description, dayKey, time, minutes });
      }}
    >
      <div className="cal-pop-head">
        <strong>New appointment</strong>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={14} strokeWidth={2.2} aria-hidden />
        </button>
      </div>

      <label className="cal-field">
        <span>Patient</span>
        <select
          ref={(el) => {
            firstField.current = el;
          }}
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
          required
        >
          {patients.length === 0 && <option value="">No patients registered</option>}
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className="cal-field">
        <span>Visit</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Follow-up visit"
          maxLength={120}
        />
      </label>

      <div className="cal-pop-row">
        <label className="cal-field">
          <span>Date</span>
          <input type="date" value={dayKey} onChange={(e) => setDayKey(e.target.value)} required />
        </label>
        <label className="cal-field">
          <span>Time</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
        </label>
        <label className="cal-field">
          <span>Length</span>
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} min
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="cal-pop-actions">
        <button type="button" className="cal-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="cal-btn cal-btn-primary" disabled={busy || !patientId}>
          Book
        </button>
      </div>
    </form>
  );
}

function DetailPanel({
  appointment,
  timeZone,
  busy,
  onClose,
  onCancelVisit,
  onRestore,
  onMove,
  firstField,
}: CalendarPopoverProps & {
  firstField: React.MutableRefObject<HTMLSelectElement | HTMLInputElement | null>;
}) {
  // Seed the move form from the clinic's wall clock, since that is what the
  // grid shows and what zonedIso will convert the answer back from.
  const reading = appointment?.start ? zonedReading(appointment.start, timeZone) : undefined;
  const [moving, setMoving] = useState(false);
  const [dayKey, setDayKey] = useState(reading?.dayKey ?? '');
  const [time, setTime] = useState(timeValue(reading?.minutes ?? 600));
  const [reason, setReason] = useState('');

  if (!appointment) {
    return <p className="empty">That appointment is no longer on the calendar.</p>;
  }
  const cancelled = appointment.status === 'cancelled';
  const startMinutes = reading?.minutes ?? 0;

  return (
    <>
      <div className="cal-pop-head">
        <strong>{appointment.description}</strong>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={14} strokeWidth={2.2} aria-hidden />
        </button>
      </div>

      <p className="cal-pop-meta">
        {appointment.patientName} · {fmtMinutes(startMinutes)}
        {appointment.minutes ? ` · ${appointment.minutes} min` : ''}
      </p>
      <p className="cal-pop-meta">
        <span className={`badge tone-${cancelled ? 'bad' : appointment.status === 'fulfilled' ? 'neutral' : 'accent'}`}>
          {appointment.status}
        </span>{' '}
        <span className="cal-pop-handle">{appointment.handle}</span> · booked by the {bookedByLabel(appointment.bookedBy)}
      </p>
      {cancelled && appointment.cancelledReason && <p className="cal-pop-meta">Reason: {appointment.cancelledReason}</p>}

      {moving ? (
        <>
          <div className="cal-pop-row">
            <label className="cal-field">
              <span>Date</span>
              <input type="date" value={dayKey} onChange={(e) => setDayKey(e.target.value)} />
            </label>
            <label className="cal-field">
              <span>Time</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
          <div className="cal-pop-actions">
            <button type="button" className="cal-btn" onClick={() => setMoving(false)}>
              Back
            </button>
            <button
              type="button"
              className="cal-btn cal-btn-primary"
              disabled={busy || !dayKey}
              onClick={() => onMove(appointment.id, dayKey, time)}
            >
              Save
            </button>
          </div>
        </>
      ) : cancelled ? (
        <div className="cal-pop-actions">
          <button
            type="button"
            ref={(el) => {
              firstField.current = el as unknown as HTMLInputElement;
            }}
            className="cal-btn cal-btn-primary"
            disabled={busy}
            onClick={() => onRestore(appointment.id)}
          >
            Restore this visit
          </button>
        </div>
      ) : (
        <>
          <label className="cal-field">
            <span>Reason (optional)</span>
            <input
              ref={(el) => {
                firstField.current = el;
              }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Patient rang to call it off"
              maxLength={140}
            />
          </label>
          <div className="cal-pop-actions">
            <button type="button" className="cal-btn" onClick={() => setMoving(true)}>
              Move to…
            </button>
            <button
              type="button"
              className="cal-btn cal-btn-danger"
              disabled={busy}
              onClick={() => onCancelVisit(appointment.id, reason)}
            >
              Cancel visit
            </button>
          </div>
        </>
      )}
    </>
  );
}
