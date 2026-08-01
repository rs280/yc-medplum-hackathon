import { Sparkles } from 'lucide-react';
import { eventsForDay, fmtMinutes, hourWindow, layoutOverlaps, type CalDay, type CalEvent } from '@/lib/calendar';

/**
 * The week and day time-grid — one component, because a day view is just a
 * week with a single column. Blocks are absolutely positioned from their
 * start/end minutes and share a column when they overlap.
 */

export const PX_PER_MIN = 56 / 60;

export interface TimeGridProps {
  days: CalDay[];
  events: CalEvent[];
  flashIds: ReadonlySet<string>;
  dragId: string | null;
  dropKey: string | null;
  /** Minute-of-day for the now-line, or null when today isn't on screen. */
  nowMin: number | null;
  todayKey: string;
}

export function TimeGrid({ days, events, flashIds, dragId, dropKey, nowMin, todayKey }: TimeGridProps) {
  const visible = events.filter((e) => days.some((d) => d.key === e.dayKey));
  const { startMin, endMin } = hourWindow(visible);
  const height = (endMin - startMin) * PX_PER_MIN;
  const hours = Array.from({ length: Math.ceil((endMin - startMin) / 60) + 1 }, (_, i) => startMin + i * 60);

  return (
    <div className="cal-time" data-window-start={startMin}>
      <div className="cal-time-head">
        <div className="cal-time-gutter" aria-hidden />
        {days.map((day) => (
          <div key={day.key} className={`cal-time-dayhead${day.isToday ? ' is-today' : ''}`}>
            <span className="cal-time-dow">{day.date.toLocaleDateString(undefined, { weekday: 'short' })}</span>
            <span className={`cal-time-daynum${day.isToday ? ' cal-daynum-today' : ''}`}>{day.label}</span>
          </div>
        ))}
      </div>

      <div className="cal-time-scroll">
        <div className="cal-time-gutter">
          {hours.slice(0, -1).map((min) => (
            <div key={min} className="cal-hourlabel" style={{ height: 60 * PX_PER_MIN }}>
              <span>{fmtMinutes(min)}</span>
            </div>
          ))}
        </div>
        <div className="cal-cols" style={{ height }}>
          {days.map((day) => {
            const placed = layoutOverlaps(eventsForDay(visible, day.key));
            return (
              <div
                key={day.key}
                className={`cal-col${day.isToday ? ' is-today' : ''}${dropKey === day.key ? ' is-drop' : ''}`}
                data-day={day.key}
              >
                {hours.slice(0, -1).map((min) => (
                  <div
                    key={min}
                    className="cal-hour"
                    style={{ top: (min - startMin) * PX_PER_MIN, height: 60 * PX_PER_MIN }}
                    aria-hidden
                  />
                ))}
                {day.key === todayKey && nowMin !== null && nowMin >= startMin && nowMin <= endMin && (
                  <div className="cal-now" style={{ top: (nowMin - startMin) * PX_PER_MIN }} aria-hidden />
                )}
                {placed.map(({ event, column, columns }) => (
                  <TimeBlock
                    key={event.id}
                    event={event}
                    column={column}
                    columns={columns}
                    windowStart={startMin}
                    flash={flashIds.has(event.id)}
                    dragging={dragId === event.id}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TimeBlock({
  event,
  column,
  columns,
  windowStart,
  flash,
  dragging,
}: {
  event: CalEvent;
  column: number;
  columns: number;
  windowStart: number;
  flash: boolean;
  dragging: boolean;
}) {
  const classes = [
    'cal-block',
    // Three-up or worse leaves no room for the visit type — keep the time and
    // the name legible rather than showing three columns of ellipses.
    columns >= 3 ? 'is-crowded' : '',
    event.isCancelled ? 'is-cancelled' : '',
    event.isPending ? 'is-pending' : '',
    event.isAgent ? 'is-agent' : '',
    flash ? 'is-new' : '',
    dragging ? 'is-dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      data-appt-id={event.id}
      title={`${event.patientName} — ${event.title}`}
      aria-label={`${fmtMinutes(event.startMin)}, ${event.patientName}, ${event.title}${event.isCancelled ? ', cancelled' : ''}`}
      style={{
        top: (event.startMin - windowStart) * PX_PER_MIN,
        height: Math.max(22, (event.endMin - event.startMin) * PX_PER_MIN),
        left: `${(column / columns) * 100}%`,
        width: `calc(${100 / columns}% - 3px)`,
      }}
    >
      <span className="cal-block-time">
        {fmtMinutes(event.startMin)}
        {event.isAgent && <Sparkles size={10} strokeWidth={2.4} aria-hidden />}
      </span>
      <span className="cal-block-name">{event.patientName}</span>
      <span className="cal-block-title">{event.title}</span>
    </button>
  );
}
