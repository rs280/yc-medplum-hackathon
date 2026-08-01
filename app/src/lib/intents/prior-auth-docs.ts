import 'server-only';
import type { Patient, ServiceRequest } from '@medplum/fhirtypes';
import {
  coverageFor,
  displayOf,
  payerNameOf,
  readRef,
  refOf,
  type IntentConfig,
} from './shared';

export const priorAuthDocs: IntentConfig = {
  name: 'prior-auth-docs',
  label: 'Prior-Auth Docs',
  taskCode: 'prior-auth-docs',
  artifactLabel: 'prior-auth packet',
  usePubMed: false,
  systemPrompt:
    'You are the prior-authorization agent of an autonomous healthcare back office. When an order needs prior authorization, you compile the documentation packet that satisfies the payer criteria on the first submission.',
  instruction:
    'Compile the prior-authorization packet for the order in the context. From the retrieved payer criteria, enumerate each required documentation element, map the available clinical facts to it, and flag anything missing — cite each criterion with a [MOSS:<id>] marker. Set decision to "docs-compiled". Put the packet cover letter (using placeholder tokens for member details) in `letter` and the criterion-to-evidence mapping in `keyArguments`.',
  async buildContext(trigger, store) {
    const sr = trigger as ServiceRequest;
    const patientRef = sr.subject?.reference;
    const patient = await readRef<Patient>(store, patientRef);
    const coverage = await coverageFor(store, patientRef);
    const payer = payerNameOf(coverage);
    const procedureText = displayOf(sr.code) || 'the ordered service';
    const clinicalNote =
      sr.note?.map((n) => n.text).filter(Boolean).join(' ') ??
      sr.reasonCode?.map((r) => displayOf(r)).join('; ') ??
      'none on file';

    const contextTextRaw = [
      'ORDER REQUIRING PRIOR AUTHORIZATION',
      `- Patient: ${[patient?.name?.[0]?.given?.join(' '), patient?.name?.[0]?.family].filter(Boolean).join(' ') || 'unknown'}`,
      `- DOB: ${patient?.birthDate ?? 'unknown'}`,
      `- Member ID: ${coverage?.subscriberId ?? 'unknown'}`,
      `- Payer: ${payer}`,
      `- Ordered service: ${procedureText}`,
      `- Ordered on: ${sr.authoredOn?.slice(0, 10) ?? 'unknown'}`,
      `- Clinical indication: ${clinicalNote}`,
    ].join('\n');

    return {
      trigger,
      triggerRef: refOf(trigger),
      patient,
      patientRef,
      contextTextRaw,
      queryRaw: `${payer} prior authorization documentation requirements ${procedureText}`,
      phiResources: [sr, patient, coverage],
      meta: { procedure: procedureText, payer },
    };
  },
};
