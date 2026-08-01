import { ShieldCheck, Sparkles } from 'lucide-react';
import { Stagger } from '@/components/anim';
import { fmtWhen, type ChartAppointment, type PatientChart } from '@/lib/chart';
import { bookedByLabel } from '@/lib/calendar';
import { OverviewRefresh } from './OverviewRefresh';

/**
 * Summary: what you read first. The overview leads because it is the sentence
 * that orients you; the three data blocks below it are what you check against.
 */

export interface SummaryTabProps {
  chart: PatientChart;
  firstName: string;
}

function appointmentTone(status: string): string {
  if (status === 'cancelled') return 'bad';
  if (status === 'fulfilled') return 'neutral';
  return 'accent';
}

function AppointmentRow({ appointment }: { appointment: ChartAppointment }) {
  return (
    <div className={`sched-row${appointment.status === 'cancelled' ? ' is-cancelled' : ''}`}>
      <div className="sched-time">{appointment.dayLabel}</div>
      <div className="sched-body">
        <div className="sched-title">{appointment.description}</div>
        <div className="sched-meta">
          {appointment.timeLabel} · booked by the {bookedByLabel(appointment.bookedBy)}
        </div>
      </div>
      <span className={`badge tone-${appointmentTone(appointment.status)}`}>{appointment.status}</span>
    </div>
  );
}

export function SummaryTab({ chart, firstName }: SummaryTabProps) {
  const { demographics, coverage, vitals, appointments, overview } = chart;
  const visits = [...appointments.upcoming, ...appointments.past];

  return (
    <>
      <div className="card">
        <h2>Overview</h2>
        <p className="chart-overview">{overview.text}</p>
        <div className="chart-overview-foot">
          <Sparkles size={12} strokeWidth={2.2} aria-hidden />
          {overview.engine === 'anthropic' ? 'AI-written from this chart' : 'Assembled from the record'}
          {overview.generatedAt ? ` · ${fmtWhen(overview.generatedAt)}` : ''}
          {overview.redactionCount != null && overview.redactionCount > 0
            ? ` · ${overview.redactionCount} PHI value(s) tokenized before the model saw it`
            : ''}
          {overview.stale && <span className="badge tone-neutral">may be out of date</span>}
          <OverviewRefresh patientId={demographics.id} />
        </div>
      </div>

      <div className="card">
        <h2>Insurance</h2>
        {coverage ? (
          <>
            <div className="chart-coverage">
              <span className="patient-payer">{coverage.payer}</span>
              {coverage.status && (
                <span className={`badge tone-${coverage.status === 'active' ? 'good' : 'neutral'}`}>
                  <ShieldCheck size={12} strokeWidth={2.2} aria-hidden />
                  {coverage.status}
                </span>
              )}
            </div>
            <dl className="chart-facts">
              <div className="chart-fact">
                <dt>Member ID</dt>
                <dd>{coverage.memberId ?? '—'}</dd>
              </div>
              <div className="chart-fact">
                <dt>Group</dt>
                <dd>{coverage.groupNumber ?? '—'}</dd>
              </div>
              <div className="chart-fact">
                <dt>Plan</dt>
                <dd>{coverage.planName ?? '—'}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="empty">Self-pay — no coverage on file.</p>
        )}
      </div>

      <div className="card">
        <h2>Appointments</h2>
        {visits.length === 0 ? (
          <p className="empty">
            Nothing booked. Ask the copilot: <em>&ldquo;book {firstName} a follow-up next Tuesday&rdquo;</em>.
          </p>
        ) : (
          <Stagger signal={`${demographics.id}:${visits.length}`}>
            <div className="sched">
              {visits.map((a) => (
                <AppointmentRow key={a.id} appointment={a} />
              ))}
            </div>
          </Stagger>
        )}
      </div>

      <div className="card">
        <h2>General information</h2>
        <dl className="chart-facts">
          <div className="chart-fact">
            <dt>Sex</dt>
            <dd>{demographics.sex ?? '—'}</dd>
          </div>
          <div className="chart-fact">
            <dt>Date of birth</dt>
            <dd>{demographics.dob ?? '—'}</dd>
          </div>
          <div className="chart-fact">
            <dt>Age</dt>
            <dd>{demographics.ageYears != null ? `${demographics.ageYears} yrs` : '—'}</dd>
          </div>
          <div className="chart-fact">
            <dt>Height</dt>
            <dd>{vitals.height?.display ?? '—'}</dd>
          </div>
          <div className="chart-fact">
            <dt>Weight</dt>
            <dd>{vitals.weight?.display ?? '—'}</dd>
          </div>
          <div className="chart-fact">
            <dt>BMI</dt>
            <dd>{vitals.bmi ? `${vitals.bmi.display} · ${vitals.bmi.category}` : '—'}</dd>
          </div>
          <div className="chart-fact">
            <dt>Blood pressure</dt>
            <dd>{vitals.bloodPressure?.display ?? '—'}</dd>
          </div>
          <div className="chart-fact">
            <dt>Heart rate</dt>
            <dd>{vitals.heartRate?.display ?? '—'}</dd>
          </div>
          <div className="chart-fact">
            <dt>Phone</dt>
            <dd>{demographics.phone ?? '—'}</dd>
          </div>
          <div className="chart-fact">
            <dt>MRN</dt>
            <dd>{demographics.mrn ?? '—'}</dd>
          </div>
          <div className="chart-fact chart-fact-wide">
            <dt>Address</dt>
            <dd>{demographics.address ?? '—'}</dd>
          </div>
        </dl>
        {vitals.observedAt && (
          <div className="chart-overview-foot">Vitals as of {fmtWhen(vitals.observedAt)}</div>
        )}
      </div>
    </>
  );
}
