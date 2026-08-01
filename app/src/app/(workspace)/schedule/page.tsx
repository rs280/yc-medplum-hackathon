import { CLINIC_TIME_ZONE, listCalendar } from '@/lib/appointments.server';
import { listPatients } from '@/lib/workspace.server';
import { ScheduleCalendar } from '@/components/schedule/ScheduleCalendar';

export const dynamic = 'force-dynamic';

/**
 * Schedule: the clinic calendar. Every appointment in the store ships on every
 * render and the client owns which slice of it you are looking at, so the 4s
 * AutoRefresh is a pure data update — agent bookings appear without ever
 * disturbing the view.
 */
export default async function SchedulePage() {
  const [appointments, patients] = await Promise.all([listCalendar({ includeCancelled: true }), listPatients()]);
  // Slimmed to what the booking form needs — no incidental PHI ships to the browser.
  const options = patients.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="page-head">
        <h1>Schedule</h1>
        <p>Follow-ups and screenings the agents booked autonomously — plus anything staff adds.</p>
      </div>

      <ScheduleCalendar appointments={appointments} patients={options} timeZone={CLINIC_TIME_ZONE} />
    </>
  );
}
