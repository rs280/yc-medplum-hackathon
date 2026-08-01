import { CalendarDays } from 'lucide-react';
import { listAppointments } from '@/lib/workspace.server';
import { Stagger } from '@/components/anim';

export const dynamic = 'force-dynamic';

/**
 * Schedule: every Appointment in the store. The discharge agent books
 * follow-ups and care-gap screenings here autonomously — run discharge
 * outreach from the copilot and watch new slots appear.
 */

function dayKey(iso?: string): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Unscheduled';
}

function fmtTime(iso?: string): string {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '—';
}

export default async function SchedulePage() {
  const appts = await listAppointments();
  const groups = new Map<string, typeof appts>();
  for (const a of appts) {
    const key = dayKey(a.start);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }

  return (
    <>
      <div className="page-head">
        <h1>Schedule</h1>
        <p>Follow-ups and screenings the discharge agent booked autonomously — plus anything staff adds.</p>
      </div>

      {appts.length === 0 ? (
        <div className="card">
          <div className="empty-illustration">
            <CalendarDays size={28} strokeWidth={1.6} aria-hidden />
          </div>
          <p className="empty" style={{ textAlign: 'center' }}>
            Nothing booked yet. Ask the copilot: <em>“run discharge outreach”</em> — the agent will screen for red
            flags, book the follow-up, and close overdue screenings, and they’ll appear here.
          </p>
        </div>
      ) : (
        [...groups.entries()].map(([day, rows]) => (
          <div key={day} className="card">
            <h2>{day}</h2>
            <Stagger signal={rows.length}>
              <div className="sched">
                {rows.map((a) => (
                  <div key={a.id} className="sched-row">
                    <div className="sched-time">{fmtTime(a.start)}</div>
                    <div className="sched-body">
                      <div className="sched-title">{a.description}</div>
                      <div className="sched-meta">
                        {a.patientName}
                        {a.bookedAt && <> · booked {new Date(a.bookedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} by the discharge agent</>}
                      </div>
                    </div>
                    <span className={`badge tone-${a.status === 'booked' ? 'accent' : 'neutral'}`}>{a.status}</span>
                  </div>
                ))}
              </div>
            </Stagger>
          </div>
        ))
      )}
    </>
  );
}
