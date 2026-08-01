import 'server-only';
import type { ClaimResponse, CodeableConcept, Coverage, Patient, Resource, ServiceRequest } from '@medplum/fhirtypes';
import type { FhirStore } from '../medplum.server';

export type IntentName = 'claim-triage' | 'denial-appeal' | 'discharge-caregap' | 'prior-auth-docs';

export interface IntentContext {
  trigger: Resource;
  triggerRef: string;
  patient?: Patient;
  patientRef?: string;
  claimRef?: string;
  denialCode?: string;
  denialLabel?: string;
  /** Raw (PHI-bearing) context for the reasoning step — redacted by the pipeline before leaving the server. */
  contextTextRaw: string;
  /** Raw retrieval query for Moss. */
  queryRaw: string;
  /** Raw PubMed term (denial-appeal only). */
  pubmedTermRaw?: string;
  /** Overdue preventive-care ServiceRequests (discharge-caregap only). */
  overdueSrs?: ServiceRequest[];
  /** Resources whose PHI values seed the redactor for this run. */
  phiResources: (Resource | undefined)[];
  /** Non-PHI facts (procedure, payer, codes) usable in prompts and templates. */
  meta: Record<string, string>;
}

export interface IntentConfig {
  name: IntentName;
  label: string;
  taskCode: string;
  artifactLabel: string;
  usePubMed: boolean;
  /** Agent persona and standing rules; reason.ts appends GLOBAL_RULES. Lives in ./prompts/<name>.ts. */
  systemPrompt: string;
  /** Per-run task directive sent as the TASK block. Lives in ./prompts/<name>.ts. */
  instruction: string;
  buildContext(trigger: Resource, store: FhirStore): Promise<IntentContext>;
}

// ── Small FHIR helpers shared by the intent configs ─────────────────────────

export function refOf(r: Resource): string {
  return `${r.resourceType}/${r.id}`;
}

export async function readRef<T extends Resource>(store: FhirStore, reference?: string): Promise<T | undefined> {
  const [type, id] = (reference ?? '').split('/');
  if (!type || !id) return undefined;
  return store.read<T>(type as T['resourceType'], id);
}

export function displayOf(cc?: CodeableConcept): string {
  const coding = cc?.coding?.[0];
  const text = cc?.text ?? coding?.display ?? '';
  return coding?.code ? `${text || 'code'} (${coding.code})` : text;
}

export function codeOf(cc?: CodeableConcept): string | undefined {
  return cc?.coding?.[0]?.code;
}

export async function coverageFor(store: FhirStore, patientRef?: string): Promise<Coverage | undefined> {
  if (!patientRef) return undefined;
  const list = await store.search<Coverage>('Coverage', { beneficiary: patientRef });
  return list[0];
}

export function payerNameOf(coverage?: Coverage, fallback = 'the payer'): string {
  return coverage?.payor?.[0]?.display ?? fallback;
}

export function money(v?: number): string {
  return v == null ? 'n/a' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

export function phoneOf(patient?: Patient): string | undefined {
  return patient?.telecom?.find((t) => t.system === 'phone')?.value;
}

// ── Denial semantics (CARC codes) ───────────────────────────────────────────

export const DENIAL_LABELS: Record<string, string> = {
  'CO-197': 'Prior authorization absent',
  'CO-50': 'Not medically necessary',
  'CO-16': 'Missing information',
  'CO-29': 'Timely filing expired',
  'CO-11': 'Diagnosis inconsistent with procedure',
};

/**
 * Canonical FHIR denial: outcome 'error' and/or zeroed benefit adjudication —
 * there is no "denied" code in the ClaimResponse outcome value set.
 */
export function isDenied(cr: ClaimResponse): boolean {
  if (cr.outcome === 'complete') return false; // clean approval — text like "denial overturned" must not trip the heuristics below
  if (cr.outcome === 'error') return true;
  const unpaid = (cr.item ?? []).some((i) =>
    (i.adjudication ?? []).some(
      (a) => a.category?.coding?.some((c) => c.code === 'benefit') && (a.amount?.value ?? 1) === 0,
    ),
  );
  const text = [cr.disposition ?? '', ...(cr.processNote ?? []).map((n) => n.text ?? '')].join(' ').toLowerCase();
  return unpaid || /deni|reject|not cover|disallow/.test(text);
}

export function parseDenial(cr: ClaimResponse): { code: string; label: string; rawText: string } {
  const rawText = [cr.disposition, ...(cr.processNote ?? []).map((n) => n.text)].filter(Boolean).join(' ');
  for (const err of cr.error ?? []) {
    for (const c of err.code?.coding ?? []) {
      if (c.code && DENIAL_LABELS[c.code]) {
        return { code: c.code, label: DENIAL_LABELS[c.code], rawText };
      }
    }
  }
  const t = rawText.toLowerCase();
  if (t.includes('authorization') || t.includes('precert')) return { code: 'CO-197', label: DENIAL_LABELS['CO-197'], rawText };
  if (t.includes('necessity') || t.includes('not covered')) return { code: 'CO-50', label: DENIAL_LABELS['CO-50'], rawText };
  if (t.includes('timely') || t.includes('filing')) return { code: 'CO-29', label: DENIAL_LABELS['CO-29'], rawText };
  if (t.includes('diagnosis')) return { code: 'CO-11', label: DENIAL_LABELS['CO-11'], rawText };
  if (t.includes('information') || t.includes('documentation')) return { code: 'CO-16', label: DENIAL_LABELS['CO-16'], rawText };
  return { code: 'CO-OTH', label: 'Other denial', rawText };
}

/** CPT codes that require prior authorization (drives the ServiceRequest trigger). */
export const PRIOR_AUTH_CODES = new Set([
  '70551', '70552', '70553', // MRI brain
  '72148', '72149', '72158', // MRI lumbar spine
  '74176', '74177', '74178', // CT abdomen/pelvis
]);

/** Maps a CPT code to a de-identified PubMed search term for appeal evidence. */
export function pubmedTermFor(cptCode: string | undefined, denialCode: string): string {
  const base =
    cptCode?.startsWith('705') ? '"magnetic resonance imaging" AND headache AND (guideline OR "diagnostic yield")'
    : cptCode?.startsWith('721') ? '"magnetic resonance imaging" AND "low back pain" AND (guideline OR appropriateness)'
    : cptCode?.startsWith('741') ? '"computed tomography" AND "abdominal pain" AND (guideline OR "diagnostic yield")'
    : cptCode === '77067' ? 'screening mammography AND (guideline OR outcomes)'
    : 'diagnostic imaging AND appropriateness criteria';
  const angle =
    denialCode === 'CO-50' ? ' AND ("medical necessity" OR outcomes)' : ' AND ("prior authorization" OR utilization)';
  return base + angle;
}
