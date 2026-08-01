import 'server-only';
import type { Redacted } from '@/types/redacted';
import type { IntentConfig } from './intents/shared';
import { CRITERIA_INDEX, PLAYBOOK_INDEX, mossSearch } from './moss.server';
import { searchPubMed } from './pubmed.server';

/**
 * Step 3: retrieval router. Moss (criteria + playbooks) serves ALL intents;
 * PubMed serves clinical evidence for denial-appeal ONLY. Inputs are
 * Redacted<string> — the type system prevents raw PHI from reaching either.
 * Returned source ids ("MOSS:<id>", "PMID:<id>") are the ONLY ids the
 * reasoning step is allowed to cite.
 */

export interface RetrievedSource {
  id: string; // "MOSS:bsc-mri-brain" | "PMID:31011962"
  kind: 'moss' | 'pubmed';
  title: string;
  text: string;
}

export interface RetrievalQueries {
  criteriaQuery: Redacted;
  playbookQuery: Redacted;
  pubmedTerm?: Redacted;
}

export async function retrieve(intent: IntentConfig, queries: RetrievalQueries): Promise<RetrievedSource[]> {
  const [criteriaHits, playbookHits, evidence] = await Promise.all([
    mossSearch(CRITERIA_INDEX, queries.criteriaQuery, 3),
    mossSearch(PLAYBOOK_INDEX, queries.playbookQuery, 2),
    intent.usePubMed && queries.pubmedTerm ? searchPubMed(queries.pubmedTerm, 3) : Promise.resolve([]),
  ]);

  const sources: RetrievedSource[] = [];
  const seen = new Set<string>();
  for (const hit of [...criteriaHits, ...playbookHits]) {
    const id = `MOSS:${hit.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    sources.push({
      id,
      kind: 'moss',
      title: hit.metadata?.kind ? `${hit.metadata.kind}: ${hit.id}` : hit.id,
      text: hit.text,
    });
  }
  for (const ev of evidence) {
    const id = `PMID:${ev.pmid}`;
    if (seen.has(id)) continue;
    seen.add(id);
    sources.push({
      id,
      kind: 'pubmed',
      title: ev.title,
      text: `${ev.citation}${ev.abstract ? ` — ${ev.abstract}` : ''}`,
    });
  }
  console.log(`[retrieve] ${intent.name}: ${sources.map((s) => s.id).join(', ') || 'nothing retrieved'}`);
  return sources;
}
