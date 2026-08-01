import {
  Bot,
  CalendarPlus,
  ClipboardList,
  FileWarning,
  MessageSquareText,
  Receipt,
  Stethoscope,
  UserPlus,
  Wallet,
} from 'lucide-react';
import { listPatients, patientTimeline, type TimelineEvent } from '@/lib/workspace.server';
import { Stagger } from '@/components/anim';

export const dynamic = 'force-dynamic';

/**
 * Patients: intake record + the full journey the agents automate — from
 * registration through encounters, orders, claims, denials/appeals, and the
 * follow-ups the discharge agent books. This is the clinician-side (EHR)
 * authorized view of demo data; the redaction guarantee governs what leaves
 * the server to external services, not this chart.
 */

const KIND_ICON: Record<TimelineEvent['kind'], typeof UserPlus> = {
  intake: UserPlus,
  encounter: Stethoscope,
  order: ClipboardList,
  claim: Receipt,
  denial: FileWarning,
  approval: Wallet,
  agent: Bot,
  appointment: CalendarPlus,
  message: MessageSquareText,
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export default async function PatientsPage() {
  const patients = await listPatients();
  const timelines = await Promise.all(patients.map((p) => patientTimeline(p.id)));

  return (
    <>
      <div className="page-head">
        <h1>Patients</h1>
        <p>Intake through post-visit — every event the agents create lands on this journey automatically.</p>
      </div>

      {patients.length === 0 && (
        <div className="card">
          <p className="empty">
            No patients yet — run <code>npm run seed</code>.
          </p>
        </div>
      )}

      {patients.map((p, pi) => {
        const events = timelines[pi];
        const agentEvents = events.filter((e) => e.kind === 'agent' || e.kind === 'appointment').length;
        return (
          <section key={p.id}>
            <div className="card patient-card">
              <div className="patient-id">
                <span className="avatar">{p.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>
                <div>
                  <div className="patient-name">{p.name}</div>
                  <div className="patient-meta">
                    {p.mrn && <span>MRN {p.mrn}</span>}
                    {p.dob && <span>DOB {p.dob}</span>}
                    {p.phone && <span>{p.phone}</span>}
                  </div>
                </div>
              </div>
              <div className="patient-coverage">
                <div className="label">Coverage</div>
                <div className="patient-payer">{p.payer ?? 'Self-pay'}</div>
                {p.planId && <div className="patient-meta">Member {p.planId}</div>}
              </div>
              <div className="patient-coverage">
                <div className="label">Agent activity</div>
                <div className="patient-payer">{agentEvents} automated event(s)</div>
                <div className="patient-meta">{events.length} total on record</div>
              </div>
            </div>

            <div className="card">
              <h2>Journey</h2>
              {events.length === 0 ? (
                <p className="empty">Nothing on record yet.</p>
              ) : (
                <Stagger signal={events.length}>
                  <div className="journey">
                    {events.map((e, i) => {
                      const Icon = KIND_ICON[e.kind];
                      return (
                        <div key={i} className={`journey-item kind-${e.kind}`}>
                          <span className="journey-icon">
                            <Icon size={14} strokeWidth={2} aria-hidden />
                          </span>
                          <div className="journey-body">
                            <div className="journey-title-row">
                              <span className="journey-title">{e.title}</span>
                              {e.badge && <span className={`badge tone-${e.badge.tone}`}>{e.badge.label}</span>}
                              <span className="journey-when">{fmtWhen(e.at)}</span>
                            </div>
                            {e.detail && <div className="journey-detail">{e.detail}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Stagger>
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}
