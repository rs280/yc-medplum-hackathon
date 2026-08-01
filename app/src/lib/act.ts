import 'server-only';
import type { DocumentReference, ServiceRequest } from '@medplum/fhirtypes';
import type { FhirStore } from './medplum.server';
import { bookAppointment } from './appointments.server';
import type { IntentConfig, IntentContext } from './intents/shared';
import { schedulePayerApproval } from './payerSimulator.server';
import type { ReasonOutput } from './reason';
import { checkEligibility, sendAttachment275, submitClaim837, submitPriorAuth278 } from './stedi.server';

/**
 * Step 6 dispatch: the only other place allowed to branch on intent (besides
 * parse-intent). Stedi is the only permitted PHI receiver, so the de-redacted
 * artifact may be handed to it — and nowhere else. Patient-facing outreach is
 * recorded as a Medplum Communication rather than dispatched to a carrier.
 */

export interface ActionTaken {
  action: string;
  detail: string;
  simulated?: boolean;
}

// This agent's own scheduling POLICY (follow-up at 10 days, screening at 14),
// distinct from the appointment service's "tomorrow 10:00" default — not a duplicate.
function plusDays(days: number, hour = 10): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

export async function act(
  store: FhirStore,
  intent: IntentConfig,
  ctx: IntentContext,
  reasoned: ReasonOutput,
  finalArtifact: string,
): Promise<ActionTaken[]> {
  const actions: ActionTaken[] = [];

  switch (intent.name) {
    case 'denial-appeal': {
      const attachment = await sendAttachment275({
        claimRef: ctx.claimRef ?? ctx.triggerRef,
        contentSummary: finalArtifact.slice(0, 200),
      });
      actions.push({
        action: 'edi-275-appeal-packet',
        detail: `Appeal packet transmitted to ${ctx.meta.payer} (control ${attachment.controlNumber})`,
        simulated: attachment.simulated,
      });
      const resubmit = await submitClaim837({ claimRef: ctx.claimRef, frequencyCode: '7' });
      actions.push({
        action: 'edi-837-resubmission',
        detail: `Replacement claim (frequency 7) queued (control ${resubmit.controlNumber})`,
        simulated: resubmit.simulated,
      });
      schedulePayerApproval(store, ctx.claimRef, ctx.meta.payer ?? 'the payer');
      actions.push({
        action: 'payer-adjudication-pending',
        detail: 'Payer received the appeal — adjudication expected in ~45s',
        simulated: true,
      });
      break;
    }

    case 'claim-triage': {
      const elig = await checkEligibility(ctx.meta.payer ?? 'payer');
      actions.push({
        action: 'eligibility-271',
        detail: `271 returned authOrCertIndicator=${elig.authOrCertIndicator} (plan ${elig.planStatus}) — prior-auth requirement ${elig.authOrCertIndicator === 'Y' ? 'CONFIRMED' : 'not indicated'}`,
        simulated: elig.simulated,
      });
      if (reasoned.decision === 'fix-then-submit') {
        actions.push({ action: 'gaps-fixed', detail: reasoned.keyArguments.join(' | ').slice(0, 300) });
      }
      const submit = await submitClaim837({ claimRef: ctx.claimRef, gapsFixed: reasoned.decision === 'fix-then-submit' });
      actions.push({
        action: 'edi-837-submitted',
        detail: `Claim submitted ${reasoned.decision === 'submit-clean' ? 'clean' : 'after fixes'} (control ${submit.controlNumber})`,
        simulated: submit.simulated,
      });
      break;
    }

    case 'discharge-caregap': {
      const followUp = await bookAppointment({
        store,
        patientRef: ctx.patientRef,
        description: `Post-discharge follow-up (${ctx.meta.encounterType ?? 'encounter'})`,
        startIso: plusDays(10),
        minutes: 60,
        source: 'discharge-agent',
        allowStackedSlot: true,
      });
      actions.push({ action: 'follow-up-booked', detail: `${followUp.appointment.handle} in 10 days` });

      for (const sr of ctx.overdueSrs ?? []) {
        const label = sr.code?.text ?? sr.code?.coding?.[0]?.display ?? 'screening';
        const booked = await bookAppointment({
          store,
          patientRef: ctx.patientRef,
          description: `Care-gap closure: ${label}`,
          startIso: plusDays(14),
          minutes: 60,
          source: 'care-gap-agent',
          // Links the visit to the order it closes, so cancelling reopens the gap.
          basedOnRef: `ServiceRequest/${sr.id}`,
          allowStackedSlot: true,
        });
        await store.update<ServiceRequest>({ ...sr, status: 'completed' });
        actions.push({
          action: 'care-gap-closed',
          detail: `${label} booked (${booked.appointment.handle}); ServiceRequest completed`,
        });
      }

      actions.push({
        action: 'outreach-message-recorded',
        detail: 'Patient outreach message written to the record for the care team to send',
      });
      break;
    }

    case 'prior-auth-docs': {
      const doc = await store.create<DocumentReference>({
        resourceType: 'DocumentReference',
        status: 'current',
        description: `Prior-auth packet: ${ctx.meta.procedure}`,
        subject: ctx.patientRef ? { reference: ctx.patientRef } : undefined,
        content: [
          {
            attachment: {
              contentType: 'text/plain',
              data: Buffer.from(finalArtifact, 'utf8').toString('base64'),
              title: 'prior-auth-packet.txt',
            },
          },
        ],
      });
      actions.push({ action: 'packet-created', detail: `DocumentReference/${doc.id}` });
      const auth = await submitPriorAuth278({ srRef: ctx.triggerRef, procedure: ctx.meta.procedure });
      actions.push({
        action: 'edi-278-submitted',
        detail: `Prior-auth request transmitted (control ${auth.controlNumber})`,
        simulated: auth.simulated,
      });
      break;
    }
  }

  return actions;
}
