import 'server-only';
import type { Claim, ClaimResponse } from '@medplum/fhirtypes';
import type { FhirStore } from './medplum.server';
import { readRef } from './intents/shared';

/**
 * Fake payer: after the appeal agent transmits its 275 packet, the "payer"
 * adjudicates ~45s later by writing the same approval ClaimResponse a real
 * 835 ERA webhook would produce and running it through the pipeline
 * (feedback intent → appeal marked WON → playbook learns). In production
 * this module is replaced by Stedi's 835/277 webhook delivery. It stands
 * down if an approval for the claim is already on file (e.g. the user
 * played the payer manually before the timer fired).
 */

const ADJUDICATION_DELAY_MS = 45_000;

/** Queue the simulated payer's approval of an appealed claim. */
export function schedulePayerApproval(store: FhirStore, claimRef: string | undefined, payer: string): void {
  if (!claimRef) return;
  console.log(`[payer-sim] appeal received — payer will adjudicate ${claimRef} in ${ADJUDICATION_DELAY_MS / 1000}s`);
  setTimeout(() => {
    void adjudicate(store, claimRef, payer).catch((err) =>
      console.warn('[payer-sim] simulated adjudication failed:', err),
    );
  }, ADJUDICATION_DELAY_MS);
}

async function adjudicate(store: FhirStore, claimRef: string, payer: string): Promise<void> {
  const responses = await store.search<ClaimResponse>('ClaimResponse', {});
  if (responses.some((cr) => cr.request?.reference === claimRef && cr.outcome === 'complete')) {
    console.log(`[payer-sim] approval already on file for ${claimRef} — standing down`);
    return;
  }
  const claim = await readRef<Claim>(store, claimRef);
  if (!claim?.patient) {
    console.warn(`[payer-sim] ${claimRef} not found or has no patient — cannot adjudicate`);
    return;
  }
  const amount = claim.total?.value ?? 0;
  const approval = await store.create<ClaimResponse>({
    resourceType: 'ClaimResponse',
    status: 'active',
    type: claim.type ?? { coding: [{ code: 'professional' }] },
    use: 'claim',
    patient: claim.patient,
    created: new Date().toISOString(),
    insurer: { display: payer },
    request: { reference: claimRef },
    outcome: 'complete',
    disposition: 'Approved on appeal — claim reprocessed and payment issued.',
    payment: { type: { coding: [{ code: 'complete' }] }, amount: { value: amount, currency: 'USD' } },
    item: [
      {
        itemSequence: 1,
        adjudication: [
          {
            category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication', code: 'benefit' }] },
            amount: { value: amount, currency: 'USD' },
          },
        ],
      },
    ],
    processNote: [{ number: 1, text: 'Appeal reviewed; denial overturned; payment issued.' }],
  });
  // Deferred import: act → payerSimulator → pipeline would otherwise cycle.
  const { runPipeline } = await import('./pipeline');
  const result = await runPipeline(approval);
  console.log(`[payer-sim] adjudicated ${claimRef} ($${amount}) → pipeline ${result.status}`);
}
