import 'server-only';
import type { Patient } from '@medplum/fhirtypes';
import type { FhirStore } from './medplum.server';

/**
 * Patient identity: the one place a Patient becomes a name, or is found by one.
 * Extracted because three modules needed the same two helpers (the clinician
 * read models, the front-desk actions, and now the calendar).
 */

/** "Maria Lopez" — the full display name from the first HumanName. */
export function patientDisplayName(p: Patient): string {
  const n = p.name?.[0];
  return [n?.given?.join(' '), n?.family].filter(Boolean).join(' ') || 'Unknown patient';
}

/**
 * "Maria L." — what a shared front-desk screen shows. Used for bulk calendar
 * reads that reach the LLM, so a whole day's roster never leaves as full names.
 */
export function shortDisplayName(p: Patient): string {
  const n = p.name?.[0];
  const given = n?.given?.[0];
  const initial = n?.family?.[0];
  if (!given) return patientDisplayName(p);
  return initial ? `${given} ${initial}.` : given;
}

/** Fuzzy front-desk lookup: exact match first, then substring either direction. */
export async function findPatientByName(store: FhirStore, name: string): Promise<Patient | undefined> {
  const patients = await store.search<Patient>('Patient', {});
  const q = name.trim().toLowerCase();
  return (
    patients.find((p) => patientDisplayName(p).toLowerCase() === q) ??
    patients.find((p) => {
      const full = patientDisplayName(p).toLowerCase();
      return full.includes(q) || q.includes(full);
    })
  );
}
