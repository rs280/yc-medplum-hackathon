import { CalendarCheck, HeartPulse, MessageCircle, ShieldCheck, Signal, Wallet, Wifi } from 'lucide-react';
import Link from 'next/link';
import { patientPortal, type PortalItem } from '@/lib/workspace.server';
import { Stagger } from '@/components/anim';
import { PatientChat } from '@/components/PatientChat';

export const dynamic = 'force-dynamic';

/**
 * Patient view: the same events the agents create, seen from the patient's
 * phone. The demo move is a split story — clinician asks the copilot to do
 * something, then flip here: the patient's feed quietly filled with good
 * news. No jargon anywhere on this page by design.
 */

const KIND_META: Record<PortalItem['kind'], { Icon: typeof MessageCircle; tone: string }> = {
  message: { Icon: MessageCircle, tone: 'accent' },
  visit: { Icon: CalendarCheck, tone: 'accent' },
  screening: { Icon: HeartPulse, tone: 'good' },
  insurance_win: { Icon: Wallet, tone: 'good' },
  insurance_fight: { Icon: ShieldCheck, tone: 'warn' },
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default async function PatientViewPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const { p } = await searchParams;
  const { patient, items, patients } = await patientPortal(p);
  const firstName = patient?.name.split(' ')[0] ?? 'your patient';

  return (
    <>
      <div className="page-head">
        <h1>Patient view</h1>
        <p>What {firstName} sees on their phone while the back office works — they never see the paperwork, only the outcomes.</p>
      </div>

      {patients.length > 1 && (
        <div className="patient-switch" role="tablist" aria-label="Choose a patient">
          {patients.map((pt) => (
            <Link
              key={pt.id}
              href={`/patient?p=${pt.id}`}
              className={`switch-chip ${pt.id === patient?.id ? 'active' : ''}`}
              aria-current={pt.id === patient?.id ? 'page' : undefined}
            >
              {pt.name}
            </Link>
          ))}
        </div>
      )}

      <div className="patient-view">
        <div className="phone">
          <div className="phone-notch" />
          <div className="phone-status">
            <span>9:41</span>
            <span className="phone-status-icons">
              <Signal size={11} aria-hidden />
              <Wifi size={11} aria-hidden />
            </span>
          </div>
          <div className="phone-header">
            <span className="avatar avatar-sm">{patient ? patient.name.split(' ').map((w) => w[0]).slice(0, 2).join('') : '–'}</span>
            <div>
              <div className="phone-clinic">Lakeside Family Clinic</div>
              <div className="phone-patient">Hi {firstName} 👋</div>
            </div>
          </div>
          <div className="phone-feed">
            {items.length === 0 ? (
              <div className="phone-empty">
                Nothing yet — ask the copilot to run discharge outreach or handle a claim, then watch this phone fill
                up.
              </div>
            ) : (
              <Stagger signal={items.length}>
                <div className="phone-feed-inner">
                  {items.map((item, i) => {
                    const { Icon, tone } = KIND_META[item.kind];
                    return (
                      <div key={i} className={`phone-card tone-${tone}`}>
                        <div className="phone-card-head">
                          <span className="phone-card-icon">
                            <Icon size={13} strokeWidth={2.2} aria-hidden />
                          </span>
                          <span className="phone-card-title">{item.title}</span>
                        </div>
                        {item.body && <div className="phone-card-body">{item.body}</div>}
                        <div className="phone-card-when">{fmtWhen(item.at)}</div>
                      </div>
                    );
                  })}
                </div>
              </Stagger>
            )}
          </div>
          <PatientChat patientId={patient?.id} firstName={firstName} />
          <div className="phone-bar" />
        </div>

        <div className="patient-view-side">
          <div className="card">
            <h2>Try it live</h2>
            <p className="empty">
              From the Dashboard, tell the copilot <em>&ldquo;run discharge outreach&rdquo;</em> or <em>&ldquo;the
              payer approved claim 1&rdquo;</em> — then flip back here and watch a new card appear on the phone. And
              tap <em>Ask us anything</em> on the phone to talk to the clinic the way {firstName} would.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
