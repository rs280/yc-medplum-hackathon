import 'server-only';
import type { Basic } from '@medplum/fhirtypes';
import type { FhirStore } from '../medplum.server';
import { PLAYBOOK_INDEX, mossUpsert } from '../moss.server';
import { MEMORY_SYSTEM } from './episodic';

/**
 * Semantic memory: aggregated lessons per denial-reason code, stored as Basic
 * resources AND re-indexed into Moss after every update — so step 3 of the
 * next pipeline run retrieves past wins automatically. Winning appeals become
 * retrieval context for future ones: that is the self-improvement loop.
 */

export const PLAYBOOK_CODE = 'playbook-entry';
const EXT_URL = 'https://autonomous-backoffice.dev/ext/playbook';

export interface PlaybookEntry {
  denialCode: string;
  label: string;
  attempts: number;
  wins: number;
  losses: number;
  bestArguments: string[];
  winningPmids: string[];
  totalTurnaroundMs: number;
  resolvedCount: number;
  updatedAt: string;
}

export function avgTurnaroundMs(e: PlaybookEntry): number | null {
  return e.resolvedCount > 0 ? Math.round(e.totalTurnaroundMs / e.resolvedCount) : null;
}

function parse(basic: Basic): (PlaybookEntry & { basicId: string }) | undefined {
  const raw = basic.extension?.find((e) => e.url === EXT_URL)?.valueString;
  if (!raw || !basic.id) return undefined;
  try {
    return { ...(JSON.parse(raw) as PlaybookEntry), basicId: basic.id };
  } catch {
    return undefined;
  }
}

export async function loadPlaybook(store: FhirStore): Promise<PlaybookEntry[]> {
  const basics = await store.search<Basic>('Basic', { code: PLAYBOOK_CODE });
  return basics
    .map(parse)
    .filter((e): e is PlaybookEntry & { basicId: string } => Boolean(e))
    .sort((a, b) => a.denialCode.localeCompare(b.denialCode));
}

async function upsertEntry(
  store: FhirStore,
  denialCode: string,
  label: string,
  mutate: (entry: PlaybookEntry) => void,
): Promise<PlaybookEntry> {
  const basics = await store.search<Basic>('Basic', { code: PLAYBOOK_CODE, identifier: denialCode });
  const existing = basics.map(parse).find(Boolean);
  const entry: PlaybookEntry = existing ?? {
    denialCode,
    label,
    attempts: 0,
    wins: 0,
    losses: 0,
    bestArguments: [],
    winningPmids: [],
    totalTurnaroundMs: 0,
    resolvedCount: 0,
    updatedAt: new Date().toISOString(),
  };
  mutate(entry);
  entry.updatedAt = new Date().toISOString();
  const { basicId: _drop, ...payload } = entry as PlaybookEntry & { basicId?: string };

  if (existing?.basicId) {
    const basic = await store.read<Basic>('Basic', existing.basicId);
    if (basic) {
      await store.update<Basic>({ ...basic, extension: [{ url: EXT_URL, valueString: JSON.stringify(payload) }] });
    }
  } else {
    await store.create<Basic>({
      resourceType: 'Basic',
      code: { coding: [{ system: MEMORY_SYSTEM, code: PLAYBOOK_CODE }], text: `playbook:${denialCode}` },
      identifier: [{ system: MEMORY_SYSTEM, value: denialCode }],
      created: new Date().toISOString().slice(0, 10),
      extension: [{ url: EXT_URL, valueString: JSON.stringify(payload) }],
    });
  }
  return payload;
}

export async function registerAttempt(store: FhirStore, denialCode: string, label: string): Promise<void> {
  await upsertEntry(store, denialCode, label, (e) => {
    e.attempts += 1;
  });
}

export async function recordOutcome(
  store: FhirStore,
  denialCode: string,
  label: string,
  won: boolean,
  extras: { keyArguments: string[]; pmids: string[]; turnaroundMs: number },
): Promise<PlaybookEntry> {
  const entry = await upsertEntry(store, denialCode, label, (e) => {
    if (won) {
      e.wins += 1;
      e.bestArguments = [...new Set([...extras.keyArguments, ...e.bestArguments])].slice(0, 5);
      e.winningPmids = [...new Set([...e.winningPmids, ...extras.pmids])].slice(0, 8);
    } else {
      e.losses += 1;
    }
    e.resolvedCount += 1;
    e.totalTurnaroundMs += extras.turnaroundMs;
  });
  await reindexPlaybook(entry);
  return entry;
}

const gPlaybook = globalThis as unknown as { __playbookHydrated?: boolean };

/**
 * After a server restart the in-process fallback index has only the seed
 * corpus; pull learned entries out of Medplum and re-index them once so
 * lessons survive restarts. No-op after the first call.
 */
export async function hydrateLearnedPlaybooks(store: FhirStore): Promise<void> {
  if (gPlaybook.__playbookHydrated) return;
  gPlaybook.__playbookHydrated = true;
  try {
    const entries = await loadPlaybook(store);
    for (const entry of entries) await reindexPlaybook(entry);
    if (entries.length) console.log(`[playbook] hydrated ${entries.length} learned entr${entries.length === 1 ? 'y' : 'ies'} into Moss`);
  } catch (err) {
    console.warn('[playbook] hydration failed:', err);
  }
}

/** Push the learned entry into Moss so the NEXT appeal retrieves it in step 3. */
export async function reindexPlaybook(entry: PlaybookEntry): Promise<void> {
  const rate = entry.resolvedCount > 0 ? Math.round((100 * entry.wins) / entry.resolvedCount) : 0;
  const text = [
    `LEARNED PLAYBOOK — ${entry.denialCode} (${entry.label}).`,
    `Track record: ${entry.wins} won / ${entry.losses} lost of ${entry.attempts} appeals (${rate}% win rate among resolved).`,
    entry.bestArguments.length
      ? `Arguments that previously WON this exact denial: ${entry.bestArguments.map((a, i) => `(${i + 1}) ${a}`).join(' ')}`
      : 'No winning arguments recorded yet.',
    entry.winningPmids.length ? `Evidence PMIDs cited in winning appeals: ${entry.winningPmids.join(', ')}.` : '',
    'Recommendation: lead with these arguments and cite this evidence again.',
  ]
    .filter(Boolean)
    .join(' ');
  await mossUpsert(PLAYBOOK_INDEX, [
    { id: `learned-${entry.denialCode}`, text, metadata: { kind: 'learned-playbook', denialCode: entry.denialCode } },
  ]);
  console.log(`[playbook] re-indexed learned-${entry.denialCode} into Moss (${rate}% win rate)`);
}
