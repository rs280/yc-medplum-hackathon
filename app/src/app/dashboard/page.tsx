import { getStore } from '@/lib/medplum.server';
import { listEpisodic, type StoredEpisodic } from '@/lib/memory/episodic';
import { avgTurnaroundMs, loadPlaybook } from '@/lib/memory/playbook';
import { mossMode } from '@/lib/moss.server';
import { reasonEngine } from '@/lib/reason';
import { AutoRefresh } from './AutoRefresh';

export const dynamic = 'force-dynamic';

/**
 * Ops dashboard. Renders ONLY redacted/aggregate data (episodic summaries,
 * playbook stats) — PHI never reaches the browser; the raw artifacts live in
 * Medplum as Communications.
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
  const latest = episodic.find((e) => e.letterRedacted);

  const modes: Array<[string, string]> = [
    ['Medplum', store.mode === 'medplum' ? 'live' : 'demo store'],
    ['Moss', mossMode() === 'moss' ? 'live' : 'lexical fallback'],
    ['Reason', reasonEngine() === 'anthropic' ? 'claude' : 'template'],
    ['Stedi', process.env.STEDI_API_KEY ? 'live' : 'simulated'],
    ['Twilio', process.env.TWILIO_ACCOUNT_SID ? 'live' : 'simulated'],
  ];

  return (
    <main className="wrap">
      <div className="header">
        <div>
          <h1>Autonomous Back Office</h1>
          <p className="sub">
            Four FHIR-triggered agents · one pipeline: redact → retrieve → reason → de-redact → act → learn
          </p>
        </div>
        <AutoRefresh />
      </div>
      <div className="chips">
        {modes.map(([name, mode]) => (
          <span key={name} className="chip">
            {name}: <b>{mode}</b>
          </span>
        ))}
      </div>

      <div className="grid tiles">
        <div className="card tile" title="Won / (won + lost) across resolved appeals">
          <div className="label">Appeal win rate</div>
          <div className="value">{winRate == null ? '—' : `${winRate}%`}</div>
          <div className="note">
            {resolved > 0 ? `${won} won · ${lost} lost of ${resolved} resolved` : `${appeals.length} appeal(s), none resolved yet`}
          </div>
        </div>
        <div className="card tile" title="PHI values replaced with typed tokens before anything left the server">
          <div className="label">PHI tokens redacted</div>
          <div className="value">{redactions}</div>
          <div className="note">across {episodic.length} pipeline run(s) — zero raw PHI outbound</div>
        </div>
        <div className="card tile" title="Overdue screenings booked + completed during discharge outreach">
          <div className="label">Care gaps closed</div>
          <div className="value">{gapsClosed}</div>
          <div className="note">closed inside discharge outreach</div>
        </div>
        <div className="card tile" title="Agent memory stored as FHIR Basic resources in Medplum">
          <div className="label">Memory records</div>
          <div className="value">{episodic.length + playbook.length}</div>
          <div className="note">
            {episodic.length} episodic · {playbook.length} playbook (re-indexed into Moss)
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Win rate by denial reason — learned playbook</h2>
        {playbook.length === 0 ? (
          <p className="empty">No appeals yet. Fire one: <code>npm run demo -- deny</code></p>
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
            No runs yet. Seed and fire an event: <code>npm run seed</code> then <code>npm run demo -- deny</code>
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Intent</th>
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
                    <td>{e.intent}</td>
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

      {latest && (
        <div className="card">
          <h2>
            Latest artifact — exactly as the LLM saw it (redacted: {latest.denialCode ?? latest.intent})
          </h2>
          <pre className="artifact">{latest.letterRedacted}</pre>
        </div>
      )}
    </main>
  );
}
