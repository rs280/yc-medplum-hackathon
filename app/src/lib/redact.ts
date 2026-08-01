import 'server-only';
import type { Coverage, HumanName, Patient, Practitioner, Resource } from '@medplum/fhirtypes';
import type { Redacted } from '@/types/redacted';

/**
 * Deterministic PHI redactor. PHI values harvested from FHIR resources are
 * replaced with typed tokens ([NAME_1], [DOB_1], [MRN_1], ...). The
 * token -> value surrogate map is persisted per run id so `deredact.ts` can
 * re-inject PHI server-side after the LLM step.
 *
 * Token numbering contract (relied on by the template fallback in reason.ts):
 * the patient's full name is always [NAME_1], their birth date [DOB_1], and
 * their first identifier [MRN_1], because the patient is harvested first.
 */

export type PhiType = 'NAME' | 'DOB' | 'MRN' | 'PHONE' | 'EMAIL' | 'ADDRESS' | 'ID' | 'SSN';

interface RunState {
  tokenByValue: Map<string, string>; // lowercased value -> token
  valueByToken: Map<string, string>;
  counters: Partial<Record<PhiType, number>>;
}

const g = globalThis as unknown as { __surrogateStore?: Map<string, RunState> };
const surrogates = (g.__surrogateStore ??= new Map<string, RunState>());

function nameVariants(name: HumanName | undefined): string[] {
  if (!name) return [];
  const out: string[] = [];
  const given = (name.given ?? []).join(' ').trim();
  const full = [given, name.family].filter(Boolean).join(' ').trim();
  if (name.text) out.push(name.text);
  if (full) out.push(full);
  if (given) out.push(given);
  if (name.family) out.push(name.family);
  return out;
}

interface PhiEntry {
  type: PhiType;
  value: string;
}

function harvestPhi(resources: (Resource | undefined)[]): PhiEntry[] {
  const entries: PhiEntry[] = [];
  const push = (type: PhiType, value: string | undefined) => {
    const v = (value ?? '').trim();
    if (v.length >= 3) entries.push({ type, value: v });
  };

  // Patients first — guarantees the NAME_1/DOB_1/MRN_1 numbering contract.
  const ordered = [...resources].filter((r): r is Resource => !!r);
  ordered.sort((a, b) => (a.resourceType === 'Patient' ? -1 : 0) - (b.resourceType === 'Patient' ? -1 : 0));

  for (const r of ordered) {
    if (r.resourceType === 'Patient') {
      const p = r as Patient;
      for (const n of p.name ?? []) for (const v of nameVariants(n)) push('NAME', v);
      push('DOB', p.birthDate);
      for (const id of p.identifier ?? []) push('MRN', id.value);
      for (const t of p.telecom ?? []) {
        push(t.system === 'email' ? 'EMAIL' : 'PHONE', t.value);
      }
      for (const a of p.address ?? []) {
        for (const line of a.line ?? []) push('ADDRESS', line);
        push('ADDRESS', a.city);
        push('ADDRESS', a.postalCode);
      }
    } else if (r.resourceType === 'Practitioner') {
      const p = r as Practitioner;
      for (const n of p.name ?? []) for (const v of nameVariants(n)) push('NAME', v);
    } else if (r.resourceType === 'Coverage') {
      const c = r as Coverage;
      push('ID', c.subscriberId);
      for (const id of c.identifier ?? []) push('ID', id.value);
    }
  }
  return entries;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Catch-all patterns for PHI that slips past resource harvesting.
const PATTERNS: Array<{ type: PhiType; re: RegExp }> = [
  { type: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'EMAIL', re: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi },
  { type: 'PHONE', re: /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]\d{4}\b|\+1\d{10}\b/g },
];

export interface RedactionSession {
  runId: string;
  /** Replace all known PHI in `raw` with typed tokens. */
  redact(raw: string): Redacted;
  /** Running count of individual PHI replacements made in this session. */
  readonly replacements: number;
}

export function startRedaction(runId: string, resources: (Resource | undefined)[]): RedactionSession {
  const state: RunState = { tokenByValue: new Map(), valueByToken: new Map(), counters: {} };
  surrogates.set(runId, state);

  const tokenFor = (type: PhiType, value: string): string => {
    const key = value.toLowerCase();
    const existing = state.tokenByValue.get(key);
    if (existing) return existing;
    const n = (state.counters[type] ?? 0) + 1;
    state.counters[type] = n;
    const token = `[${type}_${n}]`;
    state.tokenByValue.set(key, token);
    state.valueByToken.set(token, value);
    return token;
  };

  // Register harvested values up front (stable numbering), longest first for replacement.
  const entries = harvestPhi(resources);
  for (const e of entries) tokenFor(e.type, e.value);
  const byLength = [...entries].sort((a, b) => b.value.length - a.value.length);

  let replacements = 0;

  const session: RedactionSession = {
    runId,
    get replacements() {
      return replacements;
    },
    redact(raw: string): Redacted {
      let text = raw;
      for (const e of byLength) {
        const token = tokenFor(e.type, e.value);
        const re = new RegExp(escapeRegExp(e.value), 'gi');
        text = text.replace(re, () => {
          replacements++;
          return token;
        });
      }
      for (const p of PATTERNS) {
        text = text.replace(p.re, (match) => {
          replacements++;
          return tokenFor(p.type, match);
        });
      }
      return text as Redacted;
    },
  };
  return session;
}

export function getSurrogateEntries(runId: string): Array<[token: string, value: string]> | undefined {
  const state = surrogates.get(runId);
  return state ? [...state.valueByToken.entries()] : undefined;
}

export function releaseRun(runId: string): void {
  surrogates.delete(runId);
}
