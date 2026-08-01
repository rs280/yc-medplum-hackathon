import {
  BookOpenCheck,
  BrainCircuit,
  Crosshair,
  FileText,
  Lock,
  PhoneCall,
  Scale,
  Search,
  ShieldCheck,
  Unlock,
  Zap,
} from 'lucide-react';
import { getStore } from '@/lib/medplum.server';
import { listEpisodic, type StoredEpisodic } from '@/lib/memory/episodic';
import { avgTurnaroundMs, loadPlaybook } from '@/lib/memory/playbook';
import { listCalendar } from '@/lib/appointments.server';
import { moneyRecovered } from '@/lib/workspace.server';
import { renderRedacted } from '@/components/Redacted';
import { CountUp, Stagger } from '@/components/anim';

export const dynamic = 'force-dynamic';

/**
 * Ops overview. Renders ONLY redacted/aggregate data (episodic summaries,
 * playbook stats) — external services never saw raw PHI, and this page shows
 * exactly what they saw. The Copilot panel (in the layout) drives the same
 * pipeline these cards report on.
 */

function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 90_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

const BADGES: Record<StoredEpisodic['outcome'], { icon: string; label: string }> = {
  won: { icon: '✓', label: 'WON' },
  lost: { icon: '✕', label: 'LOST' },
  pending: { icon: '◷', label: 'PENDING' },
  closed: { icon: '✓', label: 'DONE' },
  failed: { icon: '!', label: 'FAILED' },
  rejected: { icon: '⊘', label: 'REJECTED' },
};

function Badge({ outcome }: { outcome: StoredEpisodic['outcome'] }) {
  const b = BADGES[outcome];
  return (
    <span className={`badge ${outcome}`}>
      {b.icon} {b.label}
    </span>
  );
}

const AGENTS = [
  { intent: 'claim-triage', name: 'The Checker', desc: 'reviews claims before they go out, so they don’t bounce', Icon: ShieldCheck },
  { intent: 'denial-appeal', name: 'The Fighter', desc: 'when insurance says no, it appeals — with evidence', Icon: Scale },
  { intent: 'prior-auth-docs', name: 'The Paperwork', desc: 'files insurance pre-approvals nobody has time for', Icon: FileText },
  { intent: 'discharge-caregap', name: 'The Caller', desc: 'checks in after visits, books follow-ups & screenings', Icon: PhoneCall },
] as const;

const AGENT_NAME: Record<StoredEpisodic['intent'], string> = {
  'claim-triage': 'Claim Triage',
  'denial-appeal': 'Denial Appeal',
  'prior-auth-docs': 'Prior Auth',
  'discharge-caregap': 'Discharge Outreach',
};

/**
 * The headline "seeing is believing" element: the six real pipeline stages
 * for the most recent run, rendered from data captured on the episodic
 * record. The copilot streams the same stages live as they happen; this shows
 * the result of the last one, so it's true even on first paint.
 */
function RunTrace({ run }: { run: StoredEpisodic }) {
  const sourceChips = run.retrievedSourceIds.map((id) => ({ id, kind: id.startsWith('PMID:') ? 'pubmed' : 'moss' }));
  return (
    <div className="card runtrace-card">
      <div className="runtrace-head">
        <h2 style={{ margin: 0 }}>Watch it work — the last job, step by step</h2>
        <span className="live-badge">
          <span className="dot" /> {AGENT_NAME[run.intent]} · {fmtTime(run.createdAt)}
        </span>
      </div>

      <div className="runtrace-steps">
        <div className="runtrace-step">
          <div className="runtrace-step-head">
            <Crosshair className="trace-svg" size={14} aria-hidden />
            <span className="trace-label">what happened</span>
          </div>
          <div className="runtrace-body">
            {AGENT_NAME[run.intent]} woke up because of <code>{run.triggerRef}</code>
            {run.denialCode && (
              <>
                {' '}
                — insurance said no: <b>{run.denialCode}</b> ({run.denialLabel})
              </>
            )}
          </div>
        </div>

        <div className="runtrace-step">
          <div className="runtrace-step-head">
            <Lock className="trace-svg" size={14} aria-hidden />
            <span className="trace-label">hides the patient&apos;s identity</span>
          </div>
          <div className="runtrace-body">
            <b>{run.redactionCount}</b> personal detail{run.redactionCount === 1 ? '' : 's'} (name, birth date, phone…)
            swapped for placeholders before anything left the building — the AI never sees who the patient is.
          </div>
        </div>

        <div className="runtrace-step">
          <div className="runtrace-step-head">
            <Search className="trace-svg" size={14} aria-hidden />
            <span className="trace-label">reads the rulebook &amp; the research</span>
          </div>
          <div className="runtrace-body">
            {sourceChips.length === 0 ? (
              <span className="dim">nothing retrieved</span>
            ) : (
              <div className="trace-chips">
                {sourceChips.map((s) => (
                  <span key={s.id} className={`trace-chip ${s.kind === 'pubmed' ? 'chip-pubmed' : ''}`}>
                    {s.id}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="runtrace-step">
          <div className="runtrace-step-head">
            <BrainCircuit className="trace-svg" size={14} aria-hidden />
            <span className="trace-label">writes the response ({run.engine === 'anthropic' ? 'Claude' : 'template'})</span>
          </div>
          <div className="runtrace-body">
            <div className="runtrace-decision">{run.decision}</div>
            <div className="trace-text">{renderRedacted(run.rationale)}</div>
            {run.keyArguments.length > 0 && (
              <ul className="trace-list">
                {run.keyArguments.slice(0, 4).map((a, i) => (
                  <li key={i}>{renderRedacted(a)}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="runtrace-step">
          <div className="runtrace-step-head">
            <Zap className="trace-svg" size={14} aria-hidden />
            <span className="trace-label">sends it</span>
          </div>
          <div className="runtrace-body">
            {run.actionsTaken.length === 0 ? (
              <span className="dim">no dispatch</span>
            ) : (
              <div className="trace-chips">
                {run.actionsTaken.map((a, i) => (
                  <span key={i} className="trace-chip">
                    {a}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="runtrace-step">
          <div className="runtrace-step-head">
            <BookOpenCheck className="trace-svg" size={14} aria-hidden />
            <span className="trace-label">remembers what worked</span>
          </div>
          <div className="runtrace-body">
            <Badge outcome={run.outcome} />
            {run.gapsClosed ? <span className="dim"> · {run.gapsClosed} care gap(s) closed</span> : null}
            <span className="dim"> · {fmtDur(run.latencyMs)} end-to-end</span>
          </div>
        </div>
      </div>

      {run.letterRedacted && (
        <>
          <div className="runtrace-artifact-label">
            <Unlock size={13} aria-hidden style={{ verticalAlign: '-2px', marginRight: 5 }} />
            The actual letter it wrote — highlighted tags are where the patient&apos;s hidden details go back in
          </div>
          <pre className="artifact">{renderRedacted(run.letterRedacted)}</pre>
        </>
      )}
    </div>
  );
}

export default async function Dashboard() {
  const store = await getStore();
  const [episodic, playbook, recovered, appointments] = await Promise.all([
    listEpisodic(store),
    loadPlaybook(store),
    moneyRecovered(),
    listCalendar(),
  ]);

  const appeals = episodic.filter((e) => e.intent === 'denial-appeal');
  const won = appeals.filter((e) => e.outcome === 'won').length;
  const lost = appeals.filter((e) => e.outcome === 'lost').length;
  const resolved = won + lost;
  const winRate = resolved > 0 ? Math.round((100 * won) / resolved) : null;
  const gapsClosed = episodic.reduce((s, e) => s + (e.gapsClosed ?? 0), 0);
  // Rough but honest layman conversion: each completed job replaces ~45 min
  // of staff work (appeal drafting, callbacks, auth paperwork).
  const hoursSaved = Math.round(episodic.filter((e) => e.outcome !== 'failed').length * 0.75);
  const mostRecent = episodic[0];

  return (
    <>
      <div className="page-head">
        <h1>Your AI back office</h1>
        <p>Four AI teammates handle the paperwork nobody has time for. Everything below is live — nothing is staged.</p>
      </div>

      <Stagger signal={`tiles:${episodic.length}`}>
        <div className="grid tiles">
          <div className="card tile tile-hero" title="Payments recovered after the AI appealed a denial">
            <div className="label">Money recovered</div>
            <div className="value accent">
              <CountUp value={recovered} prefix="$" />
            </div>
            <div className="note">from insurance denials the AI fought and won</div>
          </div>
          <div className="card tile" title="Won / (won + lost) across resolved appeals">
            <div className="label">Appeals won</div>
            <div className="value">{winRate == null ? '—' : <CountUp value={winRate} suffix="%" />}</div>
            <div className="note">
              {resolved > 0 ? `${won} won · ${lost} lost — most clinics never even file` : 'none resolved yet'}
            </div>
          </div>
          <div className="card tile" title="~45 minutes of staff work per completed job">
            <div className="label">Staff hours saved</div>
            <div className="value">
              <CountUp value={hoursSaved} suffix="h" />
            </div>
            <div className="note">appeals, callbacks &amp; forms done automatically</div>
          </div>
          <div className="card tile" title="Follow-ups and overdue screenings booked by the caller agent">
            <div className="label">Patients looked after</div>
            <div className="value">
              <CountUp value={appointments.length + gapsClosed} />
            </div>
            <div className="note">
              {appointments.length} visit(s) booked · {gapsClosed} overdue screening(s) caught
            </div>
          </div>
        </div>
      </Stagger>

      <Stagger signal={episodic.length}>
        <div className="grid agent-strip">
          {AGENTS.map(({ intent, name, desc, Icon }) => {
            const runs = episodic.filter((e) => e.intent === intent);
            const last = runs[0];
            return (
              <div key={intent} className="card agent-card">
                <div className="agent-head">
                  <span className="agent-icon">
                    <Icon size={17} strokeWidth={2} aria-hidden />
                  </span>
                  <div>
                    <div className="agent-name">{name}</div>
                    <div className="agent-desc">{desc}</div>
                  </div>
                </div>
                <div className="agent-foot">
                  {last ? (
                    <>
                      <Badge outcome={last.outcome} />
                      <span className="agent-last">
                        {runs.length} run{runs.length === 1 ? '' : 's'} · last {fmtTime(last.createdAt)}
                      </span>
                    </>
                  ) : (
                    <span className="agent-last idle">idle — ask the copilot to run it</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Stagger>

      {mostRecent ? (
        <RunTrace run={mostRecent} />
      ) : (
        <div className="card">
          <h2>Live pipeline trace</h2>
          <p className="empty">
            No runs yet. Seed with <code>npm run seed</code>, then ask the copilot: <em>“appeal the denial on claim 1”</em> —
            watch this card fill in live.
          </p>
        </div>
      )}

      <div className="card">
        <h2>It gets smarter every time — win rate by denial reason</h2>
        {playbook.length === 0 ? (
          <p className="empty">
            No appeals yet. Ask the copilot: <em>“appeal the denial on claim 1”</em>
          </p>
        ) : (
          playbook.map((entry) => {
            const entryResolved = entry.wins + entry.losses;
            const rate = entryResolved > 0 ? Math.round((100 * entry.wins) / entryResolved) : null;
            return (
              <div key={entry.denialCode}>
                <div
                  className="bar-row"
                  title={`${entry.denialCode}: ${entry.wins} won, ${entry.losses} lost, ${entry.attempts} attempted`}
                >
                  <div className="bar-label">
                    {entry.denialCode} <span className="code">· {entry.label}</span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${rate ?? 0}%` }} />
                  </div>
                  <div className="bar-value">{rate == null ? '—' : `${rate}%`}</div>
                </div>
                <div className="bar-sub">
                  {entry.wins}W · {entry.losses}L · {entry.attempts} attempt(s) · avg turnaround {fmtDur(avgTurnaroundMs(entry))}
                  {entry.winningPmids.length > 0 && (
                    <span className="pmids">
                      {entry.winningPmids.map((p) => (
                        <span key={p} className="pmid">
                          PMID {p}
                        </span>
                      ))}
                    </span>
                  )}
                  {entry.bestArguments.length > 0 && (
                    <ul>
                      {entry.bestArguments.slice(0, 3).map((arg) => (
                        <li key={arg}>{arg}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="card">
        <h2>Everything it did — full activity log</h2>
        {episodic.length === 0 ? (
          <p className="empty">
            No runs yet. Seed with <code>npm run seed</code>, then ask the copilot to appeal a denial.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Decision</th>
                  <th>Denial</th>
                  <th>Sources</th>
                  <th>Redacted</th>
                  <th>Latency</th>
                  <th>Engine</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {episodic.slice(0, 14).map((e) => (
                  <tr key={e.runId}>
                    <td className="num">{fmtTime(e.createdAt)}</td>
                    <td>{AGENT_NAME[e.intent]}</td>
                    <td>{e.decision}</td>
                    <td className="num">{e.denialCode ?? <span className="dim">—</span>}</td>
                    <td className="num" title={e.retrievedSourceIds.join(', ')}>
                      {e.retrievedSourceIds.length}
                    </td>
                    <td className="num">{e.redactionCount}</td>
                    <td className="num">{fmtDur(e.latencyMs)}</td>
                    <td className="num">{e.engine === 'anthropic' ? 'claude' : 'tmpl'}</td>
                    <td>
                      <Badge outcome={e.outcome} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
