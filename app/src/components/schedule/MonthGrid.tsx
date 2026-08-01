import { Sparkles } from 'lucide-react';
import { eventsForDay, fmtMinutes, type CalDay, type CalEvent } from '@/lib/calendar';

/**
 * The month grid. Pure render: every interaction is read off the data
 * attributes by ScheduleCalendar's delegated handlers, so this component
 * takes no callbacks.
 */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_PILLS = 3;

export interface MonthGridProps {
  days: CalDay[];
  events: CalEvent[];
  flashIds: ReadonlySet<string>;
  dragId: string | null;
  dropKey: string | null;
}

export function MonthGrid({ days, events, flashIds, dragId, dropKey }: MonthGridProps) {
  return (
    <div className="cal-month" role="grid" aria-label="Month">
      <div className="cal-dow-row" role="row">
        {DOW.map((d) => (
          <div key={d} className="cal-dow" role="columnheader">
            {d}
          </div>
        ))}
      </div>
      <div className="cal-month-body">
        {days.map((day) => {
          const dayEvents = eventsForDay(events, day.key);
          const shown = dayEvents.slice(0, MAX_PILLS);
          const overflow = dayEvents.length - shown.length;
          return (
            <div
              key={day.key}
              className={`cal-day${day.inMonth ? '' : ' is-out'}${day.isToday ? ' is-today' : ''}${dropKey === day.key ? ' is-drop' : ''}`}
              data-day={day.key}
              role="gridcell"
              tabIndex={-1}
              aria-label={`${day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}, ${dayEvents.length} appointment${dayEvents.length === 1 ? '' : 's'}`}
            >
              <div className={`cal-daynum${day.isToday ? ' cal-daynum-today' : ''}`}>{day.label}</div>
              <div className="cal-day-events">
                {shown.map((e) => (
                  <MonthPill key={e.id} event={e} flash={flashIds.has(e.id)} dragging={dragId === e.id} />
                ))}
                {overflow > 0 && (
                  <button type="button" className="cal-more" data-more={day.key}>
                    +{overflow} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthPill({ event, flash, dragging }: { event: CalEvent; flash: boolean; dragging: boolean }) {
  const classes = [
    'cal-event',
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
    >
      <span className="cal-event-time">{fmtMinutes(event.startMin)}</span>
      {event.isAgent && <Sparkles className="cal-event-glyph" size={10} strokeWidth={2.4} aria-hidden />}
      <span className="cal-event-title">{event.patientName}</span>
    </button>
  );
}
