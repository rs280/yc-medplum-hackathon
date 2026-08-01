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

export const claimTriage: IntentConfig = {
  name: 'claim-triage',
  label: 'Claim Triage',
  taskCode: 'claim-triage',
  artifactLabel: 'triage summary',
  usePubMed: false,
  systemPrompt:
    'You are the claim-triage agent of an autonomous healthcare back office. You review claims against payer coverage criteria BEFORE submission so they go out clean and never get denied.',
  instruction:
    'Check the claim in the context against the retrieved payer criteria. Identify every gap that would trigger a denial (missing prior authorization, missing documentation, diagnosis/procedure mismatch), state the concrete fix for each, and cite the criterion with a [MOSS:<id>] marker. Set decision to "submit-clean" if there are no gaps, otherwise "fix-then-submit". Put a short triage summary (gaps found, fixes applied, submission readiness) in `letter` and each gap-fix pair in `keyArguments`.',
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
