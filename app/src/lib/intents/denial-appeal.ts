import 'server-only';
import type { Claim, ClaimResponse, Patient } from '@medplum/fhirtypes';
import {
  codeOf,
  coverageFor,
  displayOf,
  money,
  parseDenial,
  payerNameOf,
  phoneOf,
  pubmedTermFor,
  readRef,
  refOf,
  type IntentConfig,
} from './shared';
import { DENIAL_APPEAL_INSTRUCTION, DENIAL_APPEAL_SYSTEM_PROMPT } from './prompts/denial-appeal';

export const denialAppeal: IntentConfig = {
  name: 'denial-appeal',
  label: 'Denial Appeal',
  taskCode: 'denial-appeal',
  artifactLabel: 'appeal letter',
  usePubMed: true,
  systemPrompt: DENIAL_APPEAL_SYSTEM_PROMPT,
  instruction: DENIAL_APPEAL_INSTRUCTION,
  async buildContext(trigger, store) {
    const cr = trigger as ClaimResponse;
    const claimRef = cr.request?.reference;
    const claim = await readRef<Claim>(store, claimRef);
    const patientRef = claim?.patient?.reference ?? cr.patient?.reference;
    const patient = await readRef<Patient>(store, patientRef);
    const coverage = await coverageFor(store, patientRef);
    const denial = parseDenial(cr);
    const procedure = claim?.item?.[0]?.productOrService;
    const procedureText = displayOf(procedure) || 'the billed service';
    const payer = payerNameOf(coverage, cr.insurer?.display ?? 'the payer');
    const clinicalNote =
      claim?.supportingInfo?.map((s) => s.valueString).filter(Boolean).join(' ') ??
      'See attached clinical documentation.';
    const claimIdentifier = claim?.identifier?.[0]?.value ?? claimRef ?? 'unknown';
    const name = patient?.name?.[0];
    const fullName = [name?.given?.join(' '), name?.family].filter(Boolean).join(' ');

    const contextTextRaw = [
      'MEMBER',
      `- Name: ${fullName || 'unknown'}`,
      `- DOB: ${patient?.birthDate ?? 'unknown'}`,
      `- MRN: ${patient?.identifier?.[0]?.value ?? 'unknown'}`,
      `- Member ID: ${coverage?.subscriberId ?? 'unknown'}`,
      `- Phone: ${phoneOf(patient) ?? 'unknown'}`,
      'CLAIM',
      `- Claim number: ${claimIdentifier}`,
      `- Payer: ${payer}`,
      `- Service: ${procedureText}`,
      `- Billed amount: ${money(claim?.total?.value)}`,
      `- Date of service: ${claim?.created?.slice(0, 10) ?? 'unknown'}`,
      `- Diagnosis: ${claim?.diagnosis?.map((d) => displayOf(d.diagnosisCodeableConcept)).join('; ') ?? 'unknown'}`,
      'CLINICAL SUMMARY',
      `- ${clinicalNote}`,
      'DENIAL',
      `- Reason code: ${denial.code} — ${denial.label}`,
      `- Payer text: "${denial.rawText}"`,
    ].join('\n');

    return {
      trigger,
      triggerRef: refOf(trigger),
      patient,
      patientRef,
      claimRef,
      denialCode: denial.code,
      denialLabel: denial.label,
      contextTextRaw,
      queryRaw: `${payer} ${procedureText} appeal criteria ${denial.label} ${denial.code}`,
      pubmedTermRaw: pubmedTermFor(codeOf(procedure), denial.code),
      phiResources: [cr, claim, patient, coverage],
      meta: {
        procedure: procedureText,
        payer,
        denialCode: denial.code,
        denialLabel: denial.label,
        amount: money(claim?.total?.value),
        claimIdentifier,
      },
    };
  },
};
