import 'server-only';
import type { Practitioner } from '@medplum/fhirtypes';
import { CLINIC_TIME_ZONE, type CalendarAppointment } from './appointments.server';
import { todayKey, zonedReading } from './calendar';
import { getLlmClient, reasonModelId } from './llmClient';
import { getStore } from './medplum.server';
import type { IntentName } from './intents/shared';
import type { StoredEpisodic } from './memory/episodic';

/**
 * Everything the Overview hero says: who the workspace greets, how busy it is
 * right now, and one paragraph of plain English about what the back office has
 * done. The paragraph is written by Claude from AGGREGATE facts only — counts,
 * decision slugs and agent names, never a patient — so this panel honours the
 * same "the model never sees a person" rule the pipeline enforces.
 */

/** The four teammates on the roster — the denominator in "3 of 4 active". */
const AGENT_ROSTER: readonly IntentName[] = ['claim-triage', 'denial-appeal', 'prior-auth-docs', 'discharge-caregap'];

/** What each agent's work is called in the facts handed to the model. */
const WORK_LABEL: Record<IntentName, string> = {
  'claim-triage': 'checking claims before they are submitted',
  'denial-appeal': 'appealing insurance denials',
  'prior-auth-docs': 'filing insurance pre-approval paperwork',
  'discharge-caregap': 'following up with patients after visits',
};

/** An agent counts as active if it has run within a day. */
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Each completed job replaces roughly 45 minutes of staff work. */
const STAFF_HOURS_PER_RUN = 0.75;

const FALLBACK_CLINICIAN = 'Doctor';

// ── Pulse: the two counters in the hero's right-hand box ────────────────────

export interface WorkspacePulse {
  activeAgents: number;
  totalAgents: number;
  activeAgentsNote: string;
  newAppointments: number;
  newAppointmentsNote: string;
}

/** Agents that worked in the last day, and visits booked today in the clinic's zone. */
export function workspacePulse(runs: StoredEpisodic[], appointments: CalendarAppointment[]): WorkspacePulse {
  const since = Date.now() - ACTIVE_WINDOW_MS;
  const activeAgents = new Set(runs.filter((r) => Date.parse(r.createdAt) >= since).map((r) => r.intent)).size;
  const openJobs = runs.filter((r) => r.outcome === 'pending').length;

  const today = todayKey(CLINIC_TIME_ZONE);
  const bookedToday = appointments.filter(
    (a) => a.createdAt && zonedReading(a.createdAt, CLINIC_TIME_ZONE).dayKey === today,
  );
  const byAi = bookedToday.filter((a) => a.bookedBy !== 'staff').length;

  return {
    activeAgents,
    totalAgents: AGENT_ROSTER.length,
    activeAgentsNote:
      openJobs > 0
        ? `${openJobs} job${openJobs === 1 ? '' : 's'} still open`
        : activeAgents > 0
          ? 'all caught up — nothing waiting'
          : 'idle — ask the copilot to run one',
    newAppointments: bookedToday.length,
    newAppointmentsNote:
      bookedToday.length === 0
        ? `${appointments.length} on the calendar`
        : byAi > 0
          ? `${byAi} booked by the AI`
          : 'booked at the front desk',
  };
}

// ── Greeting ────────────────────────────────────────────────────────────────

/** "Good afternoon, Dr. Li" — time of day in the clinic's zone, name from FHIR. */
export async function clinicianGreeting(): Promise<string> {
  const hour = Math.floor(zonedReading(new Date().toISOString(), CLINIC_TIME_ZONE).minutes / 60);
  const partOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return `Good ${partOfDay}, ${await clinicianName()}`;
}

/** How the clinic's practitioner is addressed — "Dr. Li", not the full legal name. */
async function clinicianName(): Promise<string> {
  const store = await getStore();
  const [practitioner] = await store.search<Practitioner>('Practitioner', {});
  const name = practitioner?.name?.[0];
  if (!name?.family) return name?.text ?? FALLBACK_CLINICIAN;
  return `${name.prefix?.[0] ?? 'Dr.'} ${capitalized(name.family)}`;
}

/**
 * Lifts a lowercase family name for display — accounts registered as "smith"
 * are common and "Good afternoon, Dr. smith" reads as a bug. Only the first
 * letter is touched, so "McDonald" and "de Vries" survive intact.
 */
function capitalized(family: string): string {
  return /^[a-z]/.test(family) ? family[0].toUpperCase() + family.slice(1) : family;
}

// ── Summary paragraph ───────────────────────────────────────────────────────

export interface WorkspaceSummary {
  text: string;
  engine: 'anthropic' | 'template';
}

/** Aggregate, PHI-free view of the whole workspace — the only thing the model sees. */
interface SummaryFacts {
  moneyRecoveredUsd: number;
  appealsWon: number;
  appealsLost: number;
  appealsAwaitingPayer: number;
  staffHoursSaved: number;
  overdueScreeningsClosed: number;
  visitsOnCalendar: number;
  visitsBookedToday: number;
  agentsActive: number;
  agentsTotal: number;
  totalJobs: number;
  workByAgent: Array<{ work: string; jobsRunToDate: number; latestDecision: string }>;
}

const SUMMARY_RULES = `You write the one-paragraph status summary at the top of a small clinic's AI back-office dashboard. The reader is the clinician who runs the practice, not a technical user.

RULES:
1. Two to three sentences, 55 words at the very most. Plain English — no bullet points, no markdown, no headings, no jargon.
2. Address the reader as "you" and "your". Do NOT greet them — the page prints the greeting itself.
3. Use ONLY the numbers in FACTS. Never invent a number, a name, a payer, an event or a time frame — the facts cover no particular date range.
4. Never mention or imply an individual patient. The facts deliberately contain none.
5. Report only what actually happened and what is still in flight. Never describe what the agents do in general — the reader already knows what they are for.
6. Lead with what was won or recovered and close on whatever is still open or needs attention.
7. Warm, concrete and confident. No filler openers like "I'm happy to report".`;

// One in-flight call per distinct set of facts: the workspace re-renders every
// four seconds, so without this the dashboard would bill an LLM call per tick.
const g = globalThis as unknown as { __workspaceSummary?: { key: string; result: Promise<WorkspaceSummary> } };

/** The hero paragraph. Never rejects — a failed or unconfigured LLM falls back to a template. */
export function workspaceSummary(
  runs: StoredEpisodic[],
  appointments: CalendarAppointment[],
  moneyRecovered: number,
): Promise<WorkspaceSummary> {
  const facts = summaryFacts(runs, appointments, moneyRecovered);
  const key = JSON.stringify(facts);
  // A failed call caches its fallback too — retrying every tick would be worse.
  if (g.__workspaceSummary?.key !== key) {
    g.__workspaceSummary = { key, result: writeSummary(facts) };
  }
  return g.__workspaceSummary.result;
}

function summaryFacts(
  runs: StoredEpisodic[],
  appointments: CalendarAppointment[],
  moneyRecovered: number,
): SummaryFacts {
  const appeals = runs.filter((r) => r.intent === 'denial-appeal');
  const pulse = workspacePulse(runs, appointments);

  return {
    moneyRecoveredUsd: moneyRecovered,
    appealsWon: appeals.filter((r) => r.outcome === 'won').length,
    appealsLost: appeals.filter((r) => r.outcome === 'lost').length,
    appealsAwaitingPayer: appeals.filter((r) => r.outcome === 'pending').length,
    staffHoursSaved: Math.round(runs.filter((r) => r.outcome !== 'failed').length * STAFF_HOURS_PER_RUN),
    overdueScreeningsClosed: runs.reduce((sum, r) => sum + (r.gapsClosed ?? 0), 0),
    visitsOnCalendar: appointments.length,
    visitsBookedToday: pulse.newAppointments,
    agentsActive: pulse.activeAgents,
    agentsTotal: pulse.totalAgents,
    totalJobs: runs.length,
    workByAgent: AGENT_ROSTER.map((intent) => {
      // listEpisodic sorts newest first, so the first match is the latest run.
      const forAgent = runs.filter((r) => r.intent === intent);
      return {
        work: WORK_LABEL[intent],
        jobsRunToDate: forAgent.length,
        latestDecision: forAgent[0]?.decision ?? 'nothing yet',
      };
    }).filter((entry) => entry.jobsRunToDate > 0),
  };
}

async function writeSummary(facts: SummaryFacts): Promise<WorkspaceSummary> {
  const client = getLlmClient();
  if (client) {
    try {
      const response = await client.messages.create({
        model: reasonModelId(),
        max_tokens: 400,
        system: SUMMARY_RULES,
        messages: [{ role: 'user', content: `FACTS (JSON):\n${JSON.stringify(facts, null, 2)}` }],
      });
      const text = response.content.find((b) => b.type === 'text')?.text?.trim();
      if (text) return { text, engine: 'anthropic' };
      console.warn('[briefing] model returned no text — falling back to template');
    } catch (err) {
      console.warn('[briefing] LLM summary failed — falling back to template:', err);
    }
  }
  return { text: templateSummary(facts), engine: 'template' };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Deterministic paragraph built from the same facts, so the panel never sits empty. */
function templateSummary(facts: SummaryFacts): string {
  if (facts.totalJobs === 0) {
    return `Your ${facts.agentsTotal} AI teammates are on duty and nothing has come through yet. Seed the demo or ask the copilot to appeal a denial, and this summary fills in with exactly what they did.`;
  }

  const resolvedAppeals = facts.appealsWon + facts.appealsLost;
  const recovered =
    facts.moneyRecoveredUsd > 0
      ? `Your back office has recovered $${facts.moneyRecoveredUsd.toLocaleString()} from insurance denials`
      : 'Your back office has been working through the paperwork queue';
  const appeals = resolvedAppeals > 0 ? `, winning ${facts.appealsWon} of ${plural(resolvedAppeals, 'appeal')}` : '';
  const care = [
    facts.visitsOnCalendar > 0 ? `${plural(facts.visitsOnCalendar, 'visit')} on the calendar` : '',
    facts.overdueScreeningsClosed > 0 ? `${plural(facts.overdueScreeningsClosed, 'overdue screening')} caught` : '',
  ].filter(Boolean);
  const inFlight =
    facts.appealsAwaitingPayer > 0
      ? `${plural(facts.appealsAwaitingPayer, 'appeal')} still sitting with the payer — nothing needs you yet.`
      : `Nothing is waiting on you: all ${plural(facts.totalJobs, 'job')} are closed out.`;

  return [
    `${recovered}${appeals}, and saved you about ${plural(facts.staffHoursSaved, 'hour')} of staff time across ${plural(facts.totalJobs, 'job')}.`,
    `${facts.agentsActive} of ${facts.agentsTotal} teammates worked today${care.length > 0 ? `, leaving ${care.join(' and ')}` : ''}.`,
    inFlight,
  ].join(' ');
}
