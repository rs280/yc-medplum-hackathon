import 'server-only';
import type { IntentConfig } from './intents/shared';
import { CRITERIA_INDEX, PLAYBOOK_INDEX, mossSearch } from './moss.server';
import { searchPubMed } from './pubmed.server';

/**
 * Step 2: retrieval router. Moss (criteria + playbooks) serves ALL intents;
 * PubMed serves clinical evidence for denial-appeal ONLY.
 *
 * These are the sources the reasoning step starts with. It may retrieve more
 * itself through moss_search/pubmed_search/memory_search, and those ids become
 * citable too — see the citation ledger in reason.ts.
 */

export interface RetrievedSource {
  id: string; // "MOSS:bsc-mri-brain" | "PMID:31011962" | "MEMORY:<runId>"
  // 'memory' is a prior run of a related case, cited as institutional experience.
  kind: 'moss' | 'pubmed' | 'memory';
  title: string;
  text: string;
}

export interface RetrievalQueries {
  criteriaQuery: string;
  playbookQuery: string;
  pubmedTerm?: string;
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
