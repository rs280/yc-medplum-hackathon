import 'server-only';
import type { Claim, Patient } from '@medplum/fhirtypes';
import {
  coverageFor,
  displayOf,
  money,
  payerNameOf,
  readRef,
  refOf,
  type IntentConfig,
} from './shared';
import { CLAIM_TRIAGE_INSTRUCTION, CLAIM_TRIAGE_SYSTEM_PROMPT } from './prompts/claim-triage';

export const claimTriage: IntentConfig = {
  name: 'claim-triage',
  label: 'Claim Triage',
  taskCode: 'claim-triage',
  artifactLabel: 'triage summary',
  usePubMed: false,
  systemPrompt: CLAIM_TRIAGE_SYSTEM_PROMPT,
  instruction: CLAIM_TRIAGE_INSTRUCTION,
  async buildContext(trigger, store) {
    const claim = trigger as Claim;
    const patientRef = claim.patient?.reference;
    const patient = await readRef<Patient>(store, patientRef);
    const coverage = await coverageFor(store, patientRef);
    const payer = payerNameOf(coverage);
    const procedureText = displayOf(claim.item?.[0]?.productOrService) || 'the billed service';
    const clinicalNote = claim.supportingInfo?.map((s) => s.valueString).filter(Boolean).join(' ') ?? 'none on file';
    const hasAuth = Boolean(claim.insurance?.[0]?.preAuthRef?.length);

    const contextTextRaw = [
      'CLAIM UNDER TRIAGE (pre-submission)',
      `- Claim number: ${claim.identifier?.[0]?.value ?? refOf(claim)}`,
      `- Payer: ${payer}`,
      `- Service: ${procedureText}`,
      `- Billed amount: ${money(claim.total?.value)}`,
      `- Diagnosis: ${claim.diagnosis?.map((d) => displayOf(d.diagnosisCodeableConcept)).join('; ') ?? 'unknown'}`,
      `- Prior authorization on file: ${hasAuth ? claim.insurance?.[0]?.preAuthRef?.join(', ') : 'NONE'}`,
      `- Clinical documentation: ${clinicalNote}`,
    ].join('\n');

    return {
      trigger,
      triggerRef: refOf(trigger),
      patient,
      patientRef,
      claimRef: refOf(claim),
      contextTextRaw,
      queryRaw: `${payer} ${procedureText} coverage criteria prior authorization documentation requirements`,
      phiResources: [claim, patient, coverage],
      meta: {
        procedure: procedureText,
        payer,
        amount: money(claim.total?.value),
        claimIdentifier: claim.identifier?.[0]?.value ?? '',
        hasAuth: String(hasAuth),
      },
    };
  },
};
