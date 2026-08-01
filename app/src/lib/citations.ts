/**
 * What backed a copilot answer, gathered for the Sources button under each reply.
 *
 * Two kinds, deliberately kept apart. Retrieved sources are ids the pipeline
 * actually pulled (Moss criteria, PubMed evidence) and are verifiable. Named
 * authorities are bodies the answer named in its own prose — the copilot cites
 * clinical knowledge by name rather than by number, since it has no literature
 * search — so those are a pointer to where to look, not proof of a lookup.
 */

export interface Citation {
  id: string;
  label: string;
  kind: 'moss' | 'pubmed' | 'named';
  url?: string;
}

export interface RetrievedSource {
  id: string;
  title?: string;
}

const PUBMED = 'https://pubmed.ncbi.nlm.nih.gov';

/** A PMID the answer mentioned in prose, as "PMID:31011962" or "PubMed 31011962". */
const PROSE_PMID = /(?:PMID:?|PubMed)\s*(\d{6,9})\b/g;

/**
 * Bodies whose guidance these answers lean on. Acronyms match case-sensitively
 * so "ADA" the diabetes association does not fire on ordinary words, and each
 * carries its own guidelines site because that is what a clinician wants next.
 */
const AUTHORITIES: Array<{ match: RegExp; label: string; url: string }> = [
  { match: /\bADA\b|American Diabetes Association/, label: 'American Diabetes Association', url: 'https://diabetes.org' },
  { match: /\bAACE\b/, label: 'American Association of Clinical Endocrinology', url: 'https://pro.aace.com' },
  { match: /\bUSPSTF\b|Preventive Services Task Force/, label: 'US Preventive Services Task Force', url: 'https://www.uspreventiveservicestaskforce.org' },
  { match: /\bACC\b|American College of Cardiology/, label: 'American College of Cardiology', url: 'https://www.acc.org' },
  { match: /\bAHA\b|American Heart Association/, label: 'American Heart Association', url: 'https://professional.heart.org' },
  { match: /\bESC\b|European Society of Cardiology/, label: 'European Society of Cardiology', url: 'https://www.escardio.org' },
  { match: /\bNICE\b/, label: 'NICE (UK)', url: 'https://www.nice.org.uk' },
  { match: /\bWHO\b|World Health Organization/, label: 'World Health Organization', url: 'https://www.who.int' },
  { match: /\bCDC\b/, label: 'CDC', url: 'https://www.cdc.gov' },
  { match: /\bFDA\b/, label: 'FDA', url: 'https://www.fda.gov' },
  { match: /\bIDSA\b|Infectious Diseases Society/, label: 'Infectious Diseases Society of America', url: 'https://www.idsociety.org' },
  { match: /\bACOG\b/, label: 'ACOG', url: 'https://www.acog.org' },
  { match: /\bAAP\b|American Academy of Pediatrics/, label: 'American Academy of Pediatrics', url: 'https://www.aap.org' },
  { match: /\bACP\b|American College of Physicians/, label: 'American College of Physicians', url: 'https://www.acponline.org' },
  { match: /\bKDIGO\b/, label: 'KDIGO', url: 'https://kdigo.org' },
  { match: /\bGOLD\b/, label: 'GOLD (COPD)', url: 'https://goldcopd.org' },
  { match: /Beers criteria/i, label: 'AGS Beers Criteria', url: 'https://www.americangeriatrics.org' },
];

function retrievedCitation(source: RetrievedSource): Citation {
  if (source.id.startsWith('PMID:')) {
    const pmid = source.id.slice(5);
    return { id: source.id, label: source.title || `PubMed ${pmid}`, kind: 'pubmed', url: `${PUBMED}/${pmid}/` };
  }
  return { id: source.id, label: source.title || source.id, kind: 'moss' };
}

/**
 * Everything backing one assistant reply: the sources its pipeline steps
 * retrieved, then the authorities and PMIDs its prose named. Deduped by id,
 * retrieved first, since those are the ones that can be checked.
 */
export function collectCitations(sources: RetrievedSource[], answer: string): Citation[] {
  const byId = new Map<string, Citation>();

  for (const source of sources) {
    const citation = retrievedCitation(source);
    if (!byId.has(citation.id)) byId.set(citation.id, citation);
  }

  for (const [, pmid] of answer.matchAll(PROSE_PMID)) {
    const id = `PMID:${pmid}`;
    if (!byId.has(id)) byId.set(id, { id, label: `PubMed ${pmid}`, kind: 'pubmed', url: `${PUBMED}/${pmid}/` });
  }

  for (const authority of AUTHORITIES) {
    if (!authority.match.test(answer)) continue;
    const id = `NAMED:${authority.label}`;
    if (!byId.has(id)) byId.set(id, { id, label: authority.label, kind: 'named', url: authority.url });
  }

  return [...byId.values()];
}
