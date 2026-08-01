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
import { patientDisplayName } from '../patients.server';
import { PRIOR_AUTH_DOCS_INSTRUCTION, PRIOR_AUTH_DOCS_SYSTEM_PROMPT } from './prompts/prior-auth-docs';

export const priorAuthDocs: IntentConfig = {
  name: 'prior-auth-docs',
  label: 'Prior-Auth Docs',
  taskCode: 'prior-auth-docs',
  artifactLabel: 'prior-auth packet',
  usePubMed: false,
  systemPrompt: PRIOR_AUTH_DOCS_SYSTEM_PROMPT,
  instruction: PRIOR_AUTH_DOCS_INSTRUCTION,
  async buildContext(trigger, store) {
    const sr = trigger as ServiceRequest;
    const patientRef = sr.subject?.reference;
    const patient = await readRef<Patient>(store, patientRef);
    const coverage = await coverageFor(store, patientRef);
    const payer = payerNameOf(coverage);
    const patientName = patient ? patientDisplayName(patient) : '';
    const procedureText = displayOf(sr.code) || 'the ordered service';
    const clinicalNote =
      sr.note?.map((n) => n.text).filter(Boolean).join(' ') ??
      sr.reasonCode?.map((r) => displayOf(r)).join('; ') ??
      'none on file';

    const contextTextRaw = [
      'ORDER REQUIRING PRIOR AUTHORIZATION',
      `- Patient: ${patientName || 'unknown'}`,
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
      meta: { patientName, procedure: procedureText, payer },
    };
  },
};
