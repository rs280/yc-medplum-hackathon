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
import Link from 'next/link';
import { listPatients, patientTimeline, type TimelineEvent } from '@/lib/workspace.server';
import { Stagger } from '@/components/anim';

export const dynamic = 'force-dynamic';

/**
 * Patients: the full panel (seed hero + Synthea-generated patients), with the
 * hero's journey expanded — from registration through encounters, orders,
 * claims, denials/appeals, and the follow-ups the agents book. This is the
 * clinician-side (EHR) authorized view of synthetic data; the redaction
 * guarantee governs what leaves the server to external services.
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

function initials(name: string): string {
  return name.split(' ').map((w) => w[0]).slice(0, 2).join('');
}

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const { p } = await searchParams;
  const patients = await listPatients();
  const hero =
    patients.find((pt) => pt.id === p) ?? patients.find((pt) => pt.mrn === 'MRN-001234') ?? patients[0];
  const events = hero ? await patientTimeline(hero.id) : [];
  const roster = patients.filter((pt) => pt.id !== hero?.id);

  return (
    <>
      <div className="page-head">
        <h1>Patients</h1>
        <p>
          {patients.length} on the panel — realistic synthetic records generated with Synthea. Every event the agents
          create lands on a patient&apos;s journey automatically.
        </p>
      </div>

      {patients.length === 0 && (
        <div className="card">
          <p className="empty">
            No patients yet — run <code>npm run seed</code> and <code>npm run seed:synthea</code>.
          </p>
        </div>
      )}

      {hero && (
        <>
          <div className="card patient-card">
            <div className="patient-id">
              <span className="avatar">{initials(hero.name)}</span>
              <div>
                <div className="patient-name">{hero.name}</div>
                <div className="patient-meta">
                  {hero.mrn && <span>MRN {hero.mrn}</span>}
                  {hero.dob && <span>DOB {hero.dob}</span>}
                  {hero.phone && <span>{hero.phone}</span>}
                </div>
              </div>
            </div>
            <div className="patient-coverage">
              <div className="label">Coverage</div>
              <div className="patient-payer">{hero.payer ?? 'Self-pay'}</div>
              {hero.planId && <div className="patient-meta">Member {hero.planId}</div>}
            </div>
            <div className="patient-coverage">
              <div className="label">Agent activity</div>
              <div className="patient-payer">
                {events.filter((e) => e.kind === 'agent' || e.kind === 'appointment').length} automated event(s)
              </div>
              <div className="patient-meta">{events.length} total on record</div>
            </div>
          </div>

          <div className="card">
            <h2>{hero.name.split(' ')[0]}&apos;s journey</h2>
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
        </>
      )}

      {roster.length > 0 && (
        <div className="card">
          <h2>Rest of the panel</h2>
          <Stagger signal={roster.length}>
            <div className="roster">
              {roster.map((pt) => (
                <Link key={pt.id} href={`/patients?p=${pt.id}`} className="roster-card">
                  <span className="avatar avatar-sm">{initials(pt.name)}</span>
                  <div className="roster-body">
                    <div className="roster-name">{pt.name}</div>
                    <div className="patient-meta">
                      {pt.mrn && <span>{pt.mrn}</span>}
                      {pt.dob && <span>DOB {pt.dob}</span>}
                    </div>
                    <div className="roster-payer">{pt.payer ?? 'Self-pay'}</div>
                  </div>
                </Link>
              ))}
            </div>
          </Stagger>
        </div>
      )}
    </>
  );
}
