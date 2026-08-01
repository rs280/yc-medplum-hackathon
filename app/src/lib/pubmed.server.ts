import 'server-only';

/**
 * PubMed E-utilities — clinical evidence retrieval for the APPEAL AGENT ONLY.
 * esearch (find PMIDs) → efetch (titles/abstracts). Every clinical claim in an
 * appeal letter must cite a PMID that came out of this module; reason.ts
 * rejects any citation that did not.
 *
 * Free, no key. Rate limit: 3 req/s → calls are serialized with a 350ms gap
 * and memoized per term. Failure returns [] — the pipeline never blocks.
 */

export interface PubMedEvidence {
  pmid: string;
  title: string;
  abstract?: string;
  citation: string; // e.g. "J Gen Intern Med. 2019. PMID: 31011962"
}

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

const g = globalThis as unknown as {
  __pubmedMemo?: Map<string, PubMedEvidence[]>;
  __pubmedChain?: Promise<unknown>;
};

const memo = (g.__pubmedMemo ??= new Map<string, PubMedEvidence[]>());

/** Serialize E-utilities calls with a 350ms gap (3 req/s limit, no API key). */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__pubmedChain ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => new Promise((r) => setTimeout(r, 350)))
    .then(fn);
  g.__pubmedChain = next;
  return next;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function parseEfetchXml(xml: string): PubMedEvidence[] {
  const out: PubMedEvidence[] = [];
  const articles = xml.split('<PubmedArticle>').slice(1);
  for (const chunk of articles) {
    const pmid = chunk.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (!pmid) continue;
    const title = stripTags(chunk.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? '');
    const abstractParts = [...chunk.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) =>
      stripTags(m[1]),
    );
    const journal =
      stripTags(chunk.match(/<ISOAbbreviation>([\s\S]*?)<\/ISOAbbreviation>/)?.[1] ?? '') ||
      stripTags(chunk.match(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/)?.[1] ?? '');
    const year = chunk.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/)?.[1] ?? '';
    if (!title) continue;
    out.push({
      pmid,
      title,
      abstract: abstractParts.join(' ').slice(0, 500) || undefined,
      citation: [journal, year].filter(Boolean).join('. ') + `. PMID: ${pmid}`,
    });
  }
  return out;
}

export async function searchPubMed(term: string, max = 3): Promise<PubMedEvidence[]> {
  const key = `${term}|${max}`;
  const cached = memo.get(key);
  if (cached) return cached;
  try {
    const evidence = await throttled(async () => {
      const searchUrl = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=${max}&sort=relevance&term=${encodeURIComponent(term)}`;
      const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
      if (!searchRes.ok) throw new Error(`esearch ${searchRes.status}`);
      const searchJson = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
      const ids = searchJson.esearchresult?.idlist ?? [];
      if (ids.length === 0) return [];
      await new Promise((r) => setTimeout(r, 350));
      const fetchUrl = `${EUTILS}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=xml&id=${ids.join(',')}`;
      const fetchRes = await fetch(fetchUrl, { signal: AbortSignal.timeout(15_000) });
      if (!fetchRes.ok) throw new Error(`efetch ${fetchRes.status}`);
      return parseEfetchXml(await fetchRes.text());
    });
    memo.set(key, evidence);
    console.log(`[pubmed] "${term.slice(0, 80)}" → ${evidence.map((e) => e.pmid).join(', ') || 'no results'}`);
    return evidence;
  } catch (err) {
    console.warn('[pubmed] lookup failed, continuing without clinical evidence:', err);
    memo.set(key, []);
    return [];
  }
}
