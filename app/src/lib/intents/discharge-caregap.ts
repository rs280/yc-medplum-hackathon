import 'server-only';
import type { Encounter, Patient, ServiceRequest } from '@medplum/fhirtypes';
import { displayOf, phoneOf, readRef, refOf, type IntentConfig } from './shared';
import { patientDisplayName } from '../patients.server';
import { DISCHARGE_CAREGAP_INSTRUCTION, DISCHARGE_CAREGAP_SYSTEM_PROMPT } from './prompts/discharge-caregap';

export const dischargeCaregap: IntentConfig = {
  name: 'discharge-caregap',
  label: 'Discharge + Care Gap',
  taskCode: 'discharge-caregap',
  artifactLabel: 'outreach message',
  usePubMed: false,
  systemPrompt: DISCHARGE_CAREGAP_SYSTEM_PROMPT,
  instruction: DISCHARGE_CAREGAP_INSTRUCTION,
  async buildContext(trigger, store) {
    const encounter = trigger as Encounter;
    const patientRef = encounter.subject?.reference;
    const patient = await readRef<Patient>(store, patientRef);
    const now = Date.now();
    const srs = patientRef
      ? await store.search<ServiceRequest>('ServiceRequest', { subject: patientRef, status: 'active' })
      : [];
    const overdueSrs = srs.filter(
      (sr) => sr.occurrenceDateTime && Date.parse(sr.occurrenceDateTime) < now,
    );
    const patientName = patient ? patientDisplayName(patient) : '';
    const encounterType = encounter.type?.map((t) => displayOf(t)).join(', ') || 'clinical encounter';
    const dx = encounter.diagnosis?.map((d) => d.condition?.display).filter(Boolean).join('; ') ?? 'n/a';

    const contextTextRaw = [
      'DISCHARGED ENCOUNTER',
      `- Patient: ${patientName || 'unknown'}`,
      `- Phone: ${phoneOf(patient) ?? 'unknown'}`,
      `- Encounter: ${encounterType}`,
      `- Diagnosis/procedure: ${dx}`,
      `- Period: ${encounter.period?.start ?? '?'} → ${encounter.period?.end ?? 'now'}`,
      'OVERDUE PREVENTIVE CARE GAPS',
      ...(overdueSrs.length
        ? overdueSrs.map((sr) => `- ${displayOf(sr.code)} — due ${sr.occurrenceDateTime?.slice(0, 10)}`)
        : ['- none identified']),
    ].join('\n');

    return {
      trigger,
      triggerRef: refOf(trigger),
      patient,
      patientRef,
      contextTextRaw,
      queryRaw: `post-discharge follow-up protocol red flags ${dx} ${encounterType} care gap ${overdueSrs
        .map((sr) => displayOf(sr.code))
        .join(' ')}`,
      overdueSrs,
      phiResources: [encounter, patient],
      meta: {
        patientName,
        encounterType,
        diagnosis: dx,
        overdueCount: String(overdueSrs.length),
        overdueList: overdueSrs.map((sr) => displayOf(sr.code)).join('; '),
      },
    };
  },
};
