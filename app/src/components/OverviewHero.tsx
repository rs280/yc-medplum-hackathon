import { Sparkles } from 'lucide-react';
import { Suspense } from 'react';
import { CountUp } from '@/components/anim';
import type { WorkspacePulse, WorkspaceSummary } from '@/lib/briefing.server';

/**
 * The Overview page's hero: a greeting, one AI-written paragraph about the
 * whole back office, and the two counters that say how busy it is right now.
 * The paragraph arrives as a promise and streams into its own Suspense
 * boundary — writing it takes a model call, and the page must never wait.
 */
export function OverviewHero({
  greeting,
  pulse,
  summary,
}: {
  greeting: string;
  pulse: WorkspacePulse;
  summary: Promise<WorkspaceSummary>;
}) {
  return (
    <section className="overview-hero">
      <div className="card hero-brief">
        <div className="hero-eyebrow">
          <Sparkles size={13} aria-hidden />
          AI summary
        </div>
        <h1 className="hero-greeting">{greeting}</h1>
        <Suspense fallback={<HeroSummarySkeleton />}>
          <HeroSummary summary={summary} />
        </Suspense>
      </div>

      <div className="card hero-stats">
        <div className="hero-stat">
          <div className="hero-stat-label">Active agents</div>
          <div className="hero-stat-value">
            <CountUp value={pulse.activeAgents} />
            <span className="hero-stat-total">of {pulse.totalAgents}</span>
          </div>
          <div className="hero-stat-note">{pulse.activeAgentsNote}</div>
        </div>
        <div className="hero-stat">
          <div className="hero-stat-label">New appointments</div>
          <div className="hero-stat-value">
            <CountUp value={pulse.newAppointments} />
          </div>
          <div className="hero-stat-note">{pulse.newAppointmentsNote}</div>
        </div>
      </div>
    </section>
  );
}

async function HeroSummary({ summary }: { summary: Promise<WorkspaceSummary> }) {
  const { text, engine } = await summary;
  return (
    <>
      <p className="hero-summary">{text}</p>
      {engine === 'template' && <div className="hero-engine">no LLM key configured — deterministic summary</div>}
    </>
  );
}

function HeroSummarySkeleton() {
  return (
    <div className="hero-skeleton" aria-label="Writing your summary">
      <span style={{ width: '100%' }} />
      <span style={{ width: '94%' }} />
      <span style={{ width: '62%' }} />
    </div>
  );
}
