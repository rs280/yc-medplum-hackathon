import 'server-only';
import type { Basic } from '@medplum/fhirtypes';
import type { FhirStore } from '../medplum.server';
import type { IntentName } from '../intents/shared';

/**
 * Episodic memory: one Basic resource per pipeline run, stored in Medplum so
 * the agent's memory lives in FHIR alongside everything else. Contains ONLY
 * redacted summaries — never raw PHI.
 */

export const MEMORY_SYSTEM = 'https://autonomous-backoffice.dev/memory';
export const EPISODIC_CODE = 'episodic-run';
const EXT_URL = 'https://autonomous-backoffice.dev/ext/episodic';

export interface EpisodicRecord {
  runId: string;
  intent: IntentName;
  triggerRef: string;
  claimRef?: string;
  denialCode?: string;
  denialLabel?: string;
  /** Redacted, truncated view of what the LLM saw. */
  inputSummary: string;
  retrievedSourceIds: string[];
  decision: string;
  rationale: string;
  /** Redacted artifact as produced by the reasoning step (tokens visible). */
  letterRedacted?: string;
  keyArguments: string[];
  pmids: string[];
  actionsTaken: string[];
  gapsClosed?: number;
  engine: 'anthropic' | 'template';
  outcome: 'pending' | 'won' | 'lost' | 'closed' | 'failed';
  redactionCount: number;
  latencyMs: number;
  createdAt: string;
  resolvedAt?: string;
  turnaroundMs?: number;
}

export type StoredEpisodic = EpisodicRecord & { basicId: string };

export async function writeEpisodic(store: FhirStore, record: EpisodicRecord): Promise<Basic> {
  return store.create<Basic>({
    resourceType: 'Basic',
    code: { coding: [{ system: MEMORY_SYSTEM, code: EPISODIC_CODE }], text: `run:${record.intent}` },
    subject: { reference: record.triggerRef },
    created: record.createdAt.slice(0, 10),
    extension: [{ url: EXT_URL, valueString: JSON.stringify(record) }],
  });
}

function parse(basic: Basic): StoredEpisodic | undefined {
  const raw = basic.extension?.find((e) => e.url === EXT_URL)?.valueString;
  if (!raw || !basic.id) return undefined;
  try {
    return { ...(JSON.parse(raw) as EpisodicRecord), basicId: basic.id };
  } catch {
    return undefined;
  }
}

export async function listEpisodic(store: FhirStore): Promise<StoredEpisodic[]> {
  const basics = await store.search<Basic>('Basic', { code: EPISODIC_CODE });
  return basics
    .map(parse)
    .filter((r): r is StoredEpisodic => Boolean(r))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function updateEpisodic(
  store: FhirStore,
  basicId: string,
  patch: Partial<EpisodicRecord>,
): Promise<StoredEpisodic | undefined> {
  const basic = await store.read<Basic>('Basic', basicId);
  if (!basic) return undefined;
  const current = parse(basic);
  if (!current) return undefined;
  const { basicId: _drop, ...rest } = current;
  const merged: EpisodicRecord = { ...rest, ...patch };
  await store.update<Basic>({
    ...basic,
    extension: [{ url: EXT_URL, valueString: JSON.stringify(merged) }],
  });
  return { ...merged, basicId };
}

/** Match a later ClaimResponse back to the appeal that fought for its claim. */
export async function findPendingAppeal(store: FhirStore, claimRef: string): Promise<StoredEpisodic | undefined> {
  const all = await listEpisodic(store);
  return all.find((r) => r.intent === 'denial-appeal' && r.claimRef === claimRef && r.outcome === 'pending');
}
