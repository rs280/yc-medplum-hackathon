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
  { intent: 'claim-triage', name: 'Claim Triage', desc: 'fixes gaps before submission', Icon: ShieldCheck },
  { intent: 'denial-appeal', name: 'Denial Appeal', desc: 'drafts evidence-backed appeals', Icon: Scale },
  { intent: 'prior-auth-docs', name: 'Prior Auth', desc: 'compiles authorization packets', Icon: FileText },
  { intent: 'discharge-caregap', name: 'Discharge Outreach', desc: 'calls patients, closes care gaps', Icon: PhoneCall },
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
        <h2 style={{ margin: 0 }}>Live pipeline trace</h2>
        <span className="live-badge">
          <span className="dot" /> {AGENT_NAME[run.intent]} · {fmtTime(run.createdAt)}
        </span>
      </div>

      <div className="runtrace-steps">
        <div className="runtrace-step">
          <div className="runtrace-step-head">
            <Crosshair className="trace-svg" size={14} aria-hidden />
            <span className="trace-label">trigger</span>
          </div>
          <div className="runtrace-body">
            {AGENT_NAME[run.intent]} triggered by <code>{run.triggerRef}</code>
            {run.denialCode && (
              <>
                {' '}
                — denial <b>{run.denialCode}</b> ({run.denialLabel})
              </>
            )}
          </div>
        </div>

        <div className="runtrace-step">
          <div className="runtrace-step-head">
            <Lock className="trace-svg" size={14} aria-hidden />
            <span className="trace-label">redact PHI</span>
          </div>
          <div className="runtrace-body">
            <b>{run.redactionCount}</b> value{run.redactionCount === 1 ? '' : 's'} replaced with typed tokens before
            anything left the server — no raw PHI reached the LLM, Moss, or PubMed.
          </div>
        </div>

        <div className="runtrace-step">
          <div className="runtrace-step-head">
            <Search className="trace-svg" size={14} aria-hidden />
            <span className="trace-label">retrieve evidence</span>
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
            <span className="trace-label">reason ({run.engine === 'anthropic' ? 'claude' : 'template'})</span>
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
            <span className="trace-label">act</span>
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
            <span className="trace-label">learn</span>
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
            Artifact — exactly what the LLM produced, PHI tokens visible (never raw values)
          </div>
          <pre className="artifact">{renderRedacted(run.letterRedacted)}</pre>
        </>
      )}
    </div>
  );
}

export default async function Dashboard() {
  const store = await getStore();
  const [episodic, playbook] = await Promise.all([listEpisodic(store), loadPlaybook(store)]);

  const appeals = episodic.filter((e) => e.intent === 'denial-appeal');
  const won = appeals.filter((e) => e.outcome === 'won').length;
  const lost = appeals.filter((e) => e.outcome === 'lost').length;
  const resolved = won + lost;
  const winRate = resolved > 0 ? Math.round((100 * won) / resolved) : null;
  const redactions = episodic.reduce((s, e) => s + e.redactionCount, 0);
  const gapsClosed = episodic.reduce((s, e) => s + (e.gapsClosed ?? 0), 0);
  const mostRecent = episodic[0];

  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
        <p>Four autonomous agents on one pipeline — everything below is real system state, updating live.</p>
      </div>

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

      <div className="grid tiles" style={{ marginTop: 12 }}>
        <div className="card tile" title="Won / (won + lost) across resolved appeals">
          <div className="label">Appeal win rate</div>
          <div className="value accent">{winRate == null ? '—' : <CountUp value={winRate} suffix="%" />}</div>
          <div className="note">
            {resolved > 0 ? `${won} won · ${lost} lost of ${resolved} resolved` : `${appeals.length} appeal(s), none resolved yet`}
          </div>
        </div>
        <div className="card tile" title="PHI values replaced with typed tokens before anything left the server">
          <div className="label">PHI tokens redacted</div>
          <div className="value">
            <CountUp value={redactions} />
          </div>
          <div className="note">across {episodic.length} pipeline run(s) — zero raw PHI outbound</div>
        </div>
        <div className="card tile" title="Overdue screenings booked + completed during discharge outreach">
          <div className="label">Care gaps closed</div>
          <div className="value">
            <CountUp value={gapsClosed} />
          </div>
          <div className="note">closed inside discharge outreach</div>
        </div>
        <div className="card tile" title="Agent memory stored as FHIR Basic resources in Medplum">
          <div className="label">Memory records</div>
          <div className="value">
            <CountUp value={episodic.length + playbook.length} />
          </div>
          <div className="note">
            {episodic.length} episodic · {playbook.length} playbook (re-indexed into Moss)
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Win rate by denial reason — learned playbook</h2>
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
        <h2>Memory ledger — pipeline runs</h2>
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
