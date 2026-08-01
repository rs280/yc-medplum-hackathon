import 'server-only';
import type { Encounter, Patient, ServiceRequest } from '@medplum/fhirtypes';
import { displayOf, phoneOf, readRef, refOf, type IntentConfig } from './shared';

export const dischargeCaregap: IntentConfig = {
  name: 'discharge-caregap',
  label: 'Discharge + Care Gap',
  taskCode: 'discharge-caregap',
  artifactLabel: 'outreach message',
  usePubMed: false,
  systemPrompt:
    'You are the discharge-coordination agent of an autonomous healthcare back office. After a patient is discharged you plan the follow-up outreach, screen for red-flag symptoms per protocol, and close overdue preventive care gaps in the same touch.',
  instruction:
    'Plan the post-discharge outreach for the encounter in the context. From the retrieved protocol, list the red-flag symptoms to screen for (cite with [MOSS:<id>]), propose the follow-up window, and address EVERY overdue preventive-care gap listed. Set decision to "outreach-planned". Put the patient-facing outreach message (max ~450 characters, warm and plain-language, using the placeholder tokens for the patient name) in `letter`; put the red flags and gap plan in `keyArguments`.',
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
    const encounterType = encounter.type?.map((t) => displayOf(t)).join(', ') || 'clinical encounter';
    const dx = encounter.diagnosis?.map((d) => d.condition?.display).filter(Boolean).join('; ') ?? 'n/a';

    const contextTextRaw = [
      'DISCHARGED ENCOUNTER',
      `- Patient: ${[patient?.name?.[0]?.given?.join(' '), patient?.name?.[0]?.family].filter(Boolean).join(' ') || 'unknown'}`,
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
        encounterType,
        diagnosis: dx,
        overdueCount: String(overdueSrs.length),
        overdueList: overdueSrs.map((sr) => displayOf(sr.code)).join('; '),
      },
    };
  },
};
