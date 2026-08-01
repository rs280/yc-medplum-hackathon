import 'server-only';
import type { Appointment, DocumentReference, ServiceRequest } from '@medplum/fhirtypes';
import type { FhirStore } from './medplum.server';
import type { IntentConfig, IntentContext } from './intents/shared';
import type { ReasonOutput } from './reason';
import { phoneOf } from './intents/shared';
import { checkEligibility, sendAttachment275, submitClaim837, submitPriorAuth278 } from './stedi.server';
import { sendFax, sendSms } from './twilio.server';

/**
 * Step 6 dispatch: the only other place allowed to branch on intent (besides
 * parse-intent). Twilio and Stedi are the two permitted PHI receivers, so the
 * de-redacted artifact may be handed to them — and nowhere else.
 */

export interface ActionTaken {
  action: string;
  detail: string;
  simulated?: boolean;
}

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
      const fax = await sendFax('+15555550111', finalArtifact);
      actions.push({ action: 'fax-appeal-letter', detail: `Fax dispatched (${fax.sid})`, simulated: fax.simulated });
      const resubmit = await submitClaim837({ claimRef: ctx.claimRef, frequencyCode: '7' });
      actions.push({
        action: 'edi-837-resubmission',
        detail: `Replacement claim (frequency 7) queued (control ${resubmit.controlNumber})`,
        simulated: resubmit.simulated,
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
      const followUp = await store.create<Appointment>({
        resourceType: 'Appointment',
        status: 'booked',
        description: `Post-discharge follow-up (${ctx.meta.encounterType ?? 'encounter'})`,
        start: plusDays(10),
        end: plusDays(10, 11),
        participant: [{ actor: { reference: ctx.patientRef }, status: 'accepted' }],
      });
      actions.push({ action: 'follow-up-booked', detail: `Appointment/${followUp.id} in 10 days` });

      for (const sr of ctx.overdueSrs ?? []) {
        const appt = await store.create<Appointment>({
          resourceType: 'Appointment',
          status: 'booked',
          description: `Care-gap closure: ${sr.code?.text ?? sr.code?.coding?.[0]?.display ?? 'screening'}`,
          start: plusDays(14),
          end: plusDays(14, 11),
          participant: [{ actor: { reference: ctx.patientRef }, status: 'accepted' }],
        });
        await store.update<ServiceRequest>({ ...sr, status: 'completed' });
        actions.push({
          action: 'care-gap-closed',
          detail: `${sr.code?.text ?? sr.code?.coding?.[0]?.display ?? 'screening'} booked (Appointment/${appt.id}); ServiceRequest completed`,
        });
      }

      const sms = await sendSms(phoneOf(ctx.patient) ?? '+15555550100', finalArtifact);
      actions.push({ action: 'sms-outreach', detail: `Outreach SMS ${sms.sid} → ${sms.to}`, simulated: sms.simulated });
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
