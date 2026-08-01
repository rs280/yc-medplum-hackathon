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
import { Stagger } from '@/components/anim';
import { fmtWhen, type TimelineEvent } from '@/lib/chart';

/** The patient's journey: every event the agents create, newest first. */

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

export interface JourneyTabProps {
  patientId: string;
  firstName: string;
  events: TimelineEvent[];
}

export function JourneyTab({ patientId, firstName, events }: JourneyTabProps) {
  return (
    <div className="card">
      <h2>{firstName}&apos;s journey</h2>
      {events.length === 0 ? (
        <p className="empty">Nothing on record yet.</p>
      ) : (
        // Signal stays stable across the 4s refresh but changes when you switch
        // patients — so this animates on arrival, not on every tick.
        <Stagger signal={`${patientId}:${events.length}`}>
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
  );
}
