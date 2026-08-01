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
import type { AuditEvent, Communication, DocumentReference, Observation, Patient } from '@medplum/fhirtypes';
import { getStore, type FhirStore } from '@/lib/medplum.server';
import { listEpisodic, type StoredEpisodic } from '@/lib/memory/episodic';
import { avgTurnaroundMs, loadPlaybook } from '@/lib/memory/playbook';
import { listCalendar } from '@/lib/appointments.server';
import { clinicianGreeting, workspacePulse, workspaceSummary } from '@/lib/briefing.server';
import { mossMode } from '@/lib/moss.server';
import { reasonEngine } from '@/lib/reason';
import { moneyRecovered } from '@/lib/workspace.server';
import { OverviewCapabilities, type Capability } from '@/components/OverviewCapabilities';
import { OverviewHero } from '@/components/OverviewHero';
import { renderRedacted } from '@/components/Redacted';
import { Stagger } from '@/components/anim';

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
  // An unrecognised or missing outcome must not take the whole page down with
  // it — the dashboard is the first thing anyone sees.
  const b = BADGES[outcome] ?? { icon: '·', label: String(outcome ?? 'UNKNOWN').toUpperCase() };
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

/**
 * The live numbers behind the capability grid. Counts come from resources this
 * page already needs plus four cheap searches — nothing here calls a model, so
 * the 4s auto-refresh stays a pure data update.
 */
async function platformStats(store: FhirStore) {
  const [patients, observations, documents, communications, audits] = await Promise.all([
    store.search<Patient>('Patient', {}),
    store.search<Observation>('Observation', {}),
    store.search<DocumentReference>('DocumentReference', {}),
    store.search<Communication>('Communication', {}),
    store.search<AuditEvent>('AuditEvent', {}),
  ]);
  return {
    patients: patients.length,
    observations: observations.length,
    documents: documents.length,
    transcripts: communications.filter((c) => c.category?.[0]?.text === 'voice-transcript').length,
    audits: audits.length,
  };
}

export default async function Dashboard() {
  const store = await getStore();
  const [episodic, playbook, recovered, appointments, greeting, stats] = await Promise.all([
    listEpisodic(store),
    loadPlaybook(store),
    moneyRecovered(),
    listCalendar(),
    clinicianGreeting(),
    platformStats(store),
  ]);

  const mostRecent = episodic[0];

  const sum = (fn: (e: StoredEpisodic) => number) => episodic.reduce((total, e) => total + fn(e), 0);
  const redactions = sum((e) => e.redactionCount);
  const sourcesRead = sum((e) => e.retrievedSourceIds.length);
  const dispatches = sum((e) => e.actionsTaken.length);
  const gapsClosed = sum((e) => e.gapsClosed ?? 0);
  const byClaude = episodic.filter((e) => e.engine === 'anthropic').length;
  const pmids = new Set(episodic.flatMap((e) => e.retrievedSourceIds.filter((id) => id.startsWith('PMID:'))));
  const wins = playbook.reduce((n, p) => n + p.wins, 0);
  const resolved = playbook.reduce((n, p) => n + p.wins + p.losses, 0);
  const agentBooked = appointments.filter((a) => a.bookedBy !== 'staff').length;

  const isLive = store.mode === 'medplum';
  const mossLive = mossMode() === 'moss';
  const claudeLive = reasonEngine() === 'anthropic';
  const stediLive = Boolean(process.env.STEDI_API_KEY);
  const deepgramLive = Boolean(process.env.DEEPGRAM_API_KEY);

  const pipeline = [
    {
      label: 'parse intent',
      value: `${episodic.length} run${episodic.length === 1 ? '' : 's'}`,
      tech: ['Medplum'],
    },
    { label: 'redact PHI', value: `${redactions} hidden`, tech: ['Deepgram'] },
    { label: 'retrieve', value: `${sourcesRead} sources`, tech: ['Moss', 'PubMed'] },
    { label: 'reason', value: claudeLive ? 'OpenRouter, Medplum, Moss' : 'template fallback' },
    { label: 'de-redact', value: 'fail-closed' },
    { label: 'act', value: `${dispatches} dispatched`, tech: ['Stedi', 'Medplum'] },
    {
      label: 'learn',
      value: `${playbook.length} lesson${playbook.length === 1 ? '' : 's'}`,
      tech: ['Moss'],
    },
  ];

  const capabilities: Capability[] = [
    {
      id: 'fhir',
      name: 'FHIR back office',
      description:
        'Medplum is the database and the queue. Patients, coverage, claims, visits, orders, documents and vitals are all real FHIR resources — nothing is kept in a side table.',
      stat: `${stats.patients} patients · ${stats.observations} vitals · ${appointments.length} visits`,
      status: { label: isLive ? 'live' : 'demo store', tone: isLive ? 'good' : 'neutral' },
    },
    {
      id: 'copilot',
      name: 'The copilot',
      description:
        'A streaming agent loop beside every page. It opens charts, records vitals, books and moves visits, files documents and fires the agents — and shows each tool call as it runs.',
      stat: `16 tools · reads and writes the chart`,
      status: { label: claudeLive ? 'Claude' : 'keyword router', tone: claudeLive ? 'good' : 'neutral' },
    },
    {
      id: 'voice',
      name: 'Voice & outreach',
      description:
        'The Caller agent runs post-visit follow-up and closes overdue screenings. Finalized call transcripts post in from Deepgram and land on the patient’s chart with PII redacted at the source.',
      stat: `${gapsClosed} care gap${gapsClosed === 1 ? '' : 's'} closed · ${stats.transcripts} transcript${stats.transcripts === 1 ? '' : 's'}`,
      status: { label: deepgramLive ? 'Deepgram key set' : 'not configured', tone: deepgramLive ? 'good' : 'neutral' },
    },
    {
      id: 'redaction',
      name: 'PHI never leaves raw',
      description:
        'Names, dates and identifiers become typed tokens before anything reaches a model, and are restored server-side. A branded Redacted type makes sending raw PHI outbound a compile error, and de-redaction fails closed.',
      stat: `${redactions} value${redactions === 1 ? '' : 's'} tokenized`,
      status: { label: 'enforced at compile time', tone: 'accent' },
    },
    {
      id: 'criteria',
      name: 'Payer criteria retrieval',
      description:
        'Moss holds each payer’s published policy plus the playbook this clinic has learned. Every won appeal is re-indexed, so the next run retrieves its own precedent.',
      stat: `${sourcesRead} source${sourcesRead === 1 ? '' : 's'} read across ${episodic.length} run${episodic.length === 1 ? '' : 's'}`,
      status: { label: mossLive ? 'live' : 'lexical fallback', tone: mossLive ? 'good' : 'neutral' },
    },
    {
      id: 'evidence',
      name: 'Clinical evidence',
      description:
        'Appeals are backed by real literature pulled from PubMed. A citation validator drops any line carrying a PMID that was not actually retrieved, so an invented reference cannot reach a payer.',
      stat: `${pmids.size} PMID${pmids.size === 1 ? '' : 's'} cited`,
      status: { label: 'live · no key needed', tone: 'good' },
    },
    {
      id: 'edi',
      name: 'Payer EDI',
      description:
        'Stedi carries the X12: 270/271 eligibility on intake, 837 claim submission, 275 attachments and 278 prior authorization.',
      stat: '270/271 · 837 · 275 · 278',
      status: { label: stediLive ? 'live' : 'simulated acks', tone: stediLive ? 'good' : 'neutral' },
    },
    {
      id: 'memory',
      name: 'Memory that compounds',
      description:
        'Every run writes an episodic record; outcomes roll up into a playbook per denial code holding the arguments and PMIDs that won. The clinic gets better at the denials it actually sees.',
      stat: `${playbook.length} denial code${playbook.length === 1 ? '' : 's'} · ${wins}/${resolved} appeals won`,
      status: { label: 'self-improving', tone: 'accent' },
    },
    {
      id: 'chart',
      name: 'The patient chart',
      description:
        'Every patient opens to a summary, their journey, their documents and the raw FHIR behind it — with an AI overview written from the record and cached, so reading a chart never spends a model call.',
      stat: `${stats.patients} charts · ${stats.documents} document${stats.documents === 1 ? '' : 's'} on file`,
      status: { label: 'live', tone: 'good' },
    },
    {
      id: 'schedule',
      name: 'One shared calendar',
      description:
        'Agents, the copilot and the front desk book into the same calendar, with conflict checks and provenance on every visit. Cancelling a care-gap visit reopens the gap it was closing.',
      stat: `${appointments.length} visit${appointments.length === 1 ? '' : 's'} · ${agentBooked} booked by the AI`,
      status: { label: 'live', tone: 'good' },
    },
    {
      id: 'audit',
      name: 'Audit trail',
      description:
        'Every agent action, chart edit, document filing and eligibility check writes an AuditEvent, and FHIR Subscriptions fire the same pipeline a copilot command does.',
      stat: `${stats.audits} audit event${stats.audits === 1 ? '' : 's'} written`,
      status: { label: 'FHIR-native', tone: 'accent' },
    },
  ];

  return (
    <>
      <OverviewHero
        greeting={greeting}
        pulse={workspacePulse(episodic, appointments)}
        // Deliberately not awaited: the hero streams the paragraph in so a
        // model call can never delay the rest of the page.
        summary={workspaceSummary(episodic, appointments, recovered)}
      />

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

      <OverviewCapabilities pipeline={pipeline} capabilities={capabilities} />

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
