import {
  BookOpenCheck,
  BrainCircuit,
  CalendarDays,
  Crosshair,
  Database,
  FileSearch,
  FlaskConical,
  Lock,
  MessageSquareText,
  Mic,
  Receipt,
  ScrollText,
  Search,
  Sparkles,
  Stethoscope,
  Unlock,
  Zap,
} from 'lucide-react';

/**
 * What the back office actually is, under the four agent cards: the one
 * pipeline they all share, then every technical surface this build wires up.
 *
 * Every number here is live, and every status chip reports what the server is
 * really running — "simulated" and "fallback" are shown as plainly as "live",
 * because a demo that overstates its plumbing is worse than one that doesn't.
 */

export interface PipelineStat {
  label: string;
  value: string;
  /** What actually carries this step — shown as chips under the number. */
  tech?: string[];
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  stat: string;
  /** What the server is really doing right now. */
  status: { label: string; tone: 'good' | 'neutral' | 'accent' };
}

export interface OverviewCapabilitiesProps {
  pipeline: PipelineStat[];
  capabilities: Capability[];
}

// The seven steps every run walks, in order. Icons match the ones the copilot
// streams live, so the diagram and the trace read as the same thing.
const PIPELINE_ICONS = [Crosshair, Lock, Search, BrainCircuit, Unlock, Zap, BookOpenCheck];

const CAPABILITY_ICONS: Record<string, typeof Database> = {
  fhir: Database,
  copilot: MessageSquareText,
  voice: Mic,
  edi: Receipt,
  criteria: FileSearch,
  evidence: FlaskConical,
  redaction: Lock,
  memory: BrainCircuit,
  chart: Stethoscope,
  schedule: CalendarDays,
  audit: ScrollText,
};

export function OverviewCapabilities({ pipeline, capabilities }: OverviewCapabilitiesProps) {
  return (
    <>
      <div className="card">
        <h2>One pipeline — every agent walks the same seven steps</h2>
        <p className="cap-lede">
          Four agents, one code path — a custom agent harness rather than a framework. Every run walks the same seven
          steps: a RAG pipeline retrieves the payer&apos;s own policy and the clinical literature, a reasoning pass
          drafts against what came back, and the outcome is written into memory the next run retrieves. Branching
          happens only at the first step and the sixth, which is why adding an agent costs a config block rather than a
          service. The loop is self-improving — a won appeal is re-indexed as precedent, so the next denial of the same
          code starts from the argument that already worked rather than from scratch.
        </p>
        <ol className="pipeline">
          {pipeline.map((step, i) => {
            const Icon = PIPELINE_ICONS[i] ?? Crosshair;
            return (
              <li key={step.label} className="pipeline-step">
                <span className="pipeline-icon">
                  <Icon size={15} strokeWidth={2} aria-hidden />
                </span>
                <span className="pipeline-label">{step.label}</span>
                <span className="pipeline-stat">{step.value}</span>
                {step.tech && step.tech.length > 0 && (
                  <span className="pipeline-tech">
                    {step.tech.map((t) => (
                      <span key={t} className="pipeline-tech-chip">
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="card">
        <h2>Under the hood — what this build actually wires up</h2>
        <p className="cap-lede">
          <Sparkles size={12} strokeWidth={2.2} aria-hidden /> Live counts from this workspace. Each chip says what the
          server is running right now, not what it could run with more keys.
        </p>
        <div className="cap-grid">
          {capabilities.map((cap) => {
            const Icon = CAPABILITY_ICONS[cap.id] ?? Database;
            return (
              <div key={cap.id} className="cap-card">
                <div className="cap-head">
                  <span className="cap-icon">
                    <Icon size={16} strokeWidth={2} aria-hidden />
                  </span>
                  <span className="cap-name">{cap.name}</span>
                  <span className={`badge tone-${cap.status.tone}`}>{cap.status.label}</span>
                </div>
                <p className="cap-desc">{cap.description}</p>
                <div className="cap-stat">{cap.stat}</div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
