import 'server-only';
import type { ClaimResponse } from '@medplum/fhirtypes';
import type { FhirStore } from '../medplum.server';
import { writeAudit } from '../medplum.server';
import { findPendingAppeal, updateEpisodic } from './episodic';
import { recordOutcome } from './playbook';

/**
 * Outcome feedback: when a later ClaimResponse resolves a prior appeal, match
 * it back to the episodic record, mark win/loss, and recompute + re-index the
 * playbook entry so the lesson is retrievable on the very next denial.
 */

export interface FeedbackResult {
  matched: boolean;
  detail: string;
}

async function resolveAppeal(store: FhirStore, claimRef: string | undefined, won: boolean): Promise<FeedbackResult> {
  if (!claimRef) return { matched: false, detail: 'ClaimResponse has no request reference' };
  const pending = await findPendingAppeal(store, claimRef);
  if (!pending) return { matched: false, detail: `No pending appeal for ${claimRef}` };

  const resolvedAt = new Date().toISOString();
  const turnaroundMs = Math.max(0, Date.parse(resolvedAt) - Date.parse(pending.createdAt));
  await updateEpisodic(store, pending.basicId, { outcome: won ? 'won' : 'lost', resolvedAt, turnaroundMs });

  if (pending.denialCode) {
    await recordOutcome(store, pending.denialCode, pending.denialLabel ?? pending.denialCode, won, {
      keyArguments: pending.keyArguments,
      pmids: pending.pmids,
      turnaroundMs,
    });
  }

  const detail = `Appeal ${pending.runId.slice(0, 8)} for ${claimRef} marked ${won ? 'WON' : 'LOST'} (${pending.denialCode ?? '?'}, ${Math.round(turnaroundMs / 1000)}s turnaround); playbook updated and re-indexed`;
  await writeAudit(store, {
    subtype: 'outcome-feedback',
    description: detail,
    entities: [claimRef, pending.triggerRef],
  });
  console.log(`[feedback] ${detail}`);
  return { matched: true, detail };
}

/** An approval (outcome: complete) landed — the pending appeal for that claim won. */
export async function applyOutcomeFeedback(store: FhirStore, cr: ClaimResponse): Promise<FeedbackResult> {
  return resolveAppeal(store, cr.request?.reference, true);
}

/** A fresh denial landed on a claim that already had a pending appeal — that appeal lost. */
export async function markPriorAppealLost(store: FhirStore, claimRef: string | undefined): Promise<FeedbackResult> {
  return resolveAppeal(store, claimRef, false);
}
