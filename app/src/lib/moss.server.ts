import 'server-only';
import { CRITERIA_DOCS, PLAYBOOK_SEED_DOCS, type CorpusDoc } from './corpus';

/**
 * Moss is the retrieval layer for every intent except the appeal agent's
 * clinical evidence (PubMed). Two indexes: payer criteria (+ LCD/NCD + SOPs)
 * and denial playbooks (seeded SOP playbooks + LEARNED playbook entries that
 * step 7 of the pipeline re-indexes after each resolved appeal).
 *
 * Queries are built from clinical and payer terms (payer, procedure, denial
 * code), not from patient identity.
 * If MOSS_PROJECT_ID/MOSS_API_KEY are unset (or a call fails), a built-in
 * lexical index over the same corpus answers instead, so the pipeline never
 * blocks on retrieval.
 */

export const CRITERIA_INDEX = 'payer-criteria';
export const PLAYBOOK_INDEX = 'denial-playbooks';

export interface MossHit {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, string>;
}

type FallbackDb = Map<string, Map<string, CorpusDoc>>;

const g = globalThis as unknown as {
  __mossClient?: Promise<any | null>;
  __mossLoaded?: Set<string>;
  __mossFallback?: FallbackDb;
};

function fallbackDb(): FallbackDb {
  if (!g.__mossFallback) {
    const db: FallbackDb = new Map();
    db.set(CRITERIA_INDEX, new Map(CRITERIA_DOCS.map((d) => [d.id, d])));
    db.set(PLAYBOOK_INDEX, new Map(PLAYBOOK_SEED_DOCS.map((d) => [d.id, d])));
    g.__mossFallback = db;
  }
  return g.__mossFallback;
}

function mossKey(): string | undefined {
  return process.env.MOSS_PROJECT_KEY || process.env.MOSS_API_KEY || undefined;
}

function mossConfigured(): boolean {
  return Boolean(process.env.MOSS_PROJECT_ID && mossKey());
}

export function mossMode(): 'moss' | 'fallback' {
  return mossConfigured() ? 'moss' : 'fallback';
}

async function getMossClient(): Promise<any | null> {
  if (!mossConfigured()) return null;
  g.__mossClient ??= (async () => {
    try {
      const { MossClient } = await import('@moss-dev/moss');
      return new MossClient(process.env.MOSS_PROJECT_ID!, mossKey()!);
    } catch (err) {
      console.warn('[moss] client init failed, using lexical fallback:', err);
      return null;
    }
  })();
  return g.__mossClient;
}

async function ensureLoaded(client: any, index: string): Promise<void> {
  g.__mossLoaded ??= new Set();
  if (g.__mossLoaded.has(index)) return;
  await client.loadIndex(index);
  g.__mossLoaded.add(index);
}

/**
 * Load both indexes once at boot (background) so the first pipeline run pays
 * ~15ms local queries instead of the one-time index+model download.
 */
async function warmIndexes(): Promise<void> {
  const client = await getMossClient();
  if (!client) return;
  for (const index of [CRITERIA_INDEX, PLAYBOOK_INDEX]) {
    try {
      await ensureLoaded(client, index);
      console.log(`[moss] index '${index}' loaded (local queries active)`);
    } catch (err) {
      console.warn(`[moss] warm-up load failed for '${index}':`, err);
    }
  }
}
if (mossConfigured()) void warmIndexes();

// ── Lexical fallback scoring ────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'not', 'has', 'have']);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function lexicalSearch(index: string, query: string, topK: number): MossHit[] {
  const docs = [...(fallbackDb().get(index)?.values() ?? [])];
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return [];
  const hits: MossHit[] = docs
    .map((doc) => {
      const hay = `${doc.id} ${doc.text} ${Object.values(doc.metadata ?? {}).join(' ')}`.toLowerCase();
      let matched = 0;
      for (const t of qTokens) if (hay.includes(t)) matched++;
      return { id: doc.id, text: doc.text, metadata: doc.metadata, score: matched / qTokens.length };
    })
    .filter((h) => h.score > 0.1)
    .sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function mossSearch(index: string, query: string, topK = 4): Promise<MossHit[]> {
  const client = await getMossClient();
  if (client) {
    try {
      await ensureLoaded(client, index);
      const result = await client.query(index, query, { topK });
      return (result.docs ?? []).map((d: any) => ({
        id: d.id,
        text: d.text,
        score: d.score,
        metadata: d.metadata,
      }));
    } catch (err) {
      console.warn(`[moss] query failed on '${index}', lexical fallback:`, err);
    }
  }
  return lexicalSearch(index, query, topK);
}

/** Upsert docs into an index (used at boot and by the playbook re-indexer). */
export async function mossUpsert(index: string, docs: CorpusDoc[]): Promise<void> {
  // Always mirror into the fallback index so retrieval keeps working even if
  // the live Moss call fails mid-demo.
  const db = fallbackDb();
  if (!db.has(index)) db.set(index, new Map());
  for (const d of docs) db.get(index)!.set(d.id, d);

  const client = await getMossClient();
  if (!client) return;
  const payload = docs.map((d) => ({ id: d.id, text: d.text, metadata: d.metadata }));
  try {
    await client.addDocs(index, payload, { upsert: true });
  } catch {
    try {
      await client.createIndex(index, payload);
    } catch (err) {
      console.warn(`[moss] upsert failed on '${index}':`, err);
      return;
    }
  }
  // Force a reload so subsequent queries see the new docs.
  g.__mossLoaded?.delete(index);
}
