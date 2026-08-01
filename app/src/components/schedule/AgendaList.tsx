import { CalendarDays, Sparkles } from 'lucide-react';
import { Stagger } from '@/components/anim';
import { bookedByLabel, fmtMinutes, type CalEvent } from '@/lib/calendar';

/**
 * The agenda view: the old flat schedule, kept because it is the fastest way
 * to read a run of days and the only view that survives a very narrow window.
 * Reuses the original .sched-* styles.
 */

export interface AgendaListProps {
  events: CalEvent[];
  flashIds: ReadonlySet<string>;
  /** Signals the entrance stagger — bound to view/anchor, never to the data. */
  signal: string;
}

export function AgendaList({ events, flashIds, signal }: AgendaListProps) {
  if (events.length === 0) {
    return (
      <div className="card">
        <div className="empty-illustration">
          <CalendarDays size={28} strokeWidth={1.6} aria-hidden />
        </div>
        <p className="empty" style={{ textAlign: 'center' }}>
          Nothing booked in this range. Ask the copilot: <em>&ldquo;run discharge outreach&rdquo;</em> — the agent will
          screen for red flags, book the follow-up, and close overdue screenings, and they&rsquo;ll appear here.
        </p>
      </div>
    );
  }

  const groups = new Map<string, CalEvent[]>();
  for (const e of events) groups.set(e.dayKey, [...(groups.get(e.dayKey) ?? []), e]);

  return (
    <>
      {[...groups.entries()].map(([key, rows]) => (
        <div key={key} className="card">
          <h2>{new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
          <Stagger signal={`${signal}:${key}`}>
            <div className="sched">
              {rows.map((e) => (
                <div key={e.id} className={`sched-row${e.isCancelled ? ' is-cancelled' : ''}${flashIds.has(e.id) ? ' is-new' : ''}`}>
                  <div className="sched-time">{fmtMinutes(e.startMin)}</div>
                  <div className="sched-body">
                    <div className="sched-title">{e.title}</div>
                    <div className="sched-meta">
                      {e.patientName} · booked by the {bookedByLabel(e.bookedBy)}
                      {e.isAgent && <Sparkles size={10} strokeWidth={2.4} aria-hidden className="sched-glyph" />}
                    </div>
                  </div>
                  <button type="button" className="sched-open" data-appt-id={e.id}>
                    <span className={`badge tone-${e.isCancelled ? 'bad' : e.status === 'fulfilled' ? 'neutral' : 'accent'}`}>
                      {e.status}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </Stagger>
        </div>
      ))}
    </>
  );
}
