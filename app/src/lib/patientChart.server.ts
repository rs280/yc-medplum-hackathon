import 'server-only';
import type { Coverage, DocumentReference, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { formatSlotParts, type CalendarAppointment } from './appointments.server';
import type {
  ChartAppointment,
  CoverageCard,
  Demographics,
  FhirEntry,
  FhirInventory,
  PatientChart,
  PatientSex,
} from './chart';
import { getStore, type FhirStore } from './medplum.server';
import { chartDocumentsFrom, strippedForDisplay } from './patientDocuments.server';
import {
  generateOverview,
  overviewFingerprint,
  overviewFrom,
  readOverviewRecord,
  type OverviewFacts,
} from './patientOverview.server';
import { patientDisplayName } from './patients.server';
import { vitalsFrom } from './vitals.server';
import { patientRecord, timelineFrom, type PatientRecord } from './workspace.server';

/**
 * THE patient chart read model: one object, one await, everything
 * /patients?p=<id> renders.
 *
 * Composed from the bundle the journey already needs — the FHIR tab and the
 * Summary tab are two views of one fetch, not two round-trips. What made this
 * expensive in the obvious design, regenerating an AI summary per render, is
 * designed out: this function NEVER calls a model. It reads the overview from
 * its FHIR cache and reports whether that cache is stale; regeneration is an
 * explicit write, because the page re-renders every few seconds.
 *
 * Search note (the trap documented in appointments.server.ts): Observation and
 * DocumentReference are fetched with `subject` only. The memory store's
 * matches() silently returns [] for `category`, so category filtering happens
 * in JS. Never add a param here without checking medplum.server.ts first.
 */

const MAX_INLINE_TEXT = 4000;

function ageFrom(birthDate?: string): number | undefined {
  if (!birthDate) return undefined;
  const dob = new Date(`${birthDate}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return undefined;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age >= 0 && age < 150 ? age : undefined;
}

function addressLine(patient: Patient): string | undefined {
  const a = patient.address?.[0];
  if (!a) return undefined;
  const line = [...(a.line ?? []), a.city, a.state, a.postalCode].filter(Boolean).join(', ');
  return line || undefined;
}

function mrnOf(p: Patient): string | undefined {
  return p.identifier?.find((i) => i.value?.startsWith('MRN'))?.value ?? p.identifier?.[0]?.value;
}

function demographicsFrom(patient: Patient): Demographics {
  return {
    id: patient.id!,
    name: patientDisplayName(patient),
    mrn: mrnOf(patient),
    sex: patient.gender as PatientSex | undefined,
    dob: patient.birthDate,
    ageYears: ageFrom(patient.birthDate),
    phone: patient.telecom?.find((t) => t.system === 'phone')?.value,
    email: patient.telecom?.find((t) => t.system === 'email')?.value,
    address: addressLine(patient),
  };
}

function coverageFrom(coverage: Coverage | undefined): CoverageCard | undefined {
  if (!coverage?.id) return undefined;
  return {
    id: coverage.id,
    payer: coverage.payor?.[0]?.display ?? 'Self-pay',
    memberId: coverage.subscriberId ?? coverage.identifier?.[0]?.value,
    groupNumber: coverage.class?.find((c) => c.type?.coding?.some((x) => x.code === 'group'))?.value,
    planName: coverage.class?.find((c) => c.type?.coding?.some((x) => x.code === 'plan'))?.value,
    status: coverage.status,
  };
}

function toChartAppointment(appointment: CalendarAppointment): ChartAppointment {
  const { dayLabel, timeLabel } = formatSlotParts(appointment.start, appointment.end);
  return {
    id: appointment.id,
    handle: appointment.handle,
    description: appointment.description,
    dayLabel,
    timeLabel,
    status: appointment.status ?? 'booked',
    bookedBy: appointment.bookedBy,
  };
}

/** One human line naming a resource in the FHIR tab's row header. */
function describeResource(resource: Resource): string {
  const r = resource as Record<string, any>;
  return (
    r.code?.text ??
    r.code?.coding?.[0]?.display ??
    r.type?.[0]?.text ??
    r.type?.text ??
    r.description ??
    r.identifier?.[0]?.value ??
    r.status ??
    resource.resourceType
  );
}

function toFhirEntry(resource: Resource): FhirEntry {
  return {
    reference: `${resource.resourceType}/${resource.id}`,
    resourceType: resource.resourceType,
    display: describeResource(resource),
    lastUpdated: resource.meta?.lastUpdated,
    // Pre-stringified so no component ever runs JSON.stringify, and stripped so
    // a base64 attachment can't multiply the payload of every refresh.
    json: JSON.stringify(strippedForDisplay(resource), null, 2),
  };
}

function inventoryFrom(resources: Resource[]): FhirInventory {
  const counts: Record<string, number> = {};
  for (const r of resources) counts[r.resourceType] = (counts[r.resourceType] ?? 0) + 1;
  const entries = resources
    .filter((r) => r.id)
    .map(toFhirEntry)
    .sort((a, b) => a.resourceType.localeCompare(b.resourceType) || a.display.localeCompare(b.display));
  return { counts, entries };
}

/** Split on the clock once, server-side, so no component does date math. */
function splitAppointments(appointments: CalendarAppointment[]): {
  upcoming: ChartAppointment[];
  past: ChartAppointment[];
} {
  const now = new Date().toISOString();
  const active = appointments.filter((a) => a.status !== 'cancelled');
  return {
    upcoming: active
      .filter((a) => (a.start ?? '') >= now)
      .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
      .map(toChartAppointment),
    past: appointments
      .filter((a) => a.status === 'cancelled' || (a.start ?? '') < now)
      .sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''))
      .map(toChartAppointment),
  };
}

function factsFrom(
  record: PatientRecord,
  demographics: Demographics,
  coverage: CoverageCard | undefined,
  observations: Observation[],
  documentCount: number,
): OverviewFacts {
  const openOrders = record.serviceRequests
    .filter((sr) => sr.status === 'active')
    .map((sr) => sr.code?.text ?? sr.code?.coding?.[0]?.display ?? 'order');
  const next = record.appointments
    .filter((a) => a.status !== 'cancelled' && (a.start ?? '') >= new Date().toISOString())
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))[0];
  return {
    ageYears: demographics.ageYears,
    sex: demographics.sex,
    payer: coverage?.payer,
    vitals: vitalsFrom(observations),
    encounterCount: record.encounters.length,
    claimCount: record.claims.length,
    denialCount: record.responses.filter((r) => r.outcome === 'error').length,
    openOrders,
    nextAppointment: next ? `${next.description}, ${formatSlotParts(next.start, next.end).dayLabel}` : undefined,
    documentCount,
  };
}

/**
 * The chart as text for the overview generator. Deliberately carries the real
 * identifying header: the redactor needs real values to tokenize, and the count
 * it returns is what the Summary tab reports.
 */
function chartAsText(
  demographics: Demographics,
  coverage: CoverageCard | undefined,
  facts: OverviewFacts,
  record: PatientRecord,
): string {
  const v = facts.vitals;
  return [
    `PATIENT: ${demographics.name}, MRN ${demographics.mrn ?? 'unknown'}, DOB ${demographics.dob ?? 'unknown'}`,
    `Phone ${demographics.phone ?? 'none'}. Address ${demographics.address ?? 'none'}.`,
    `Age ${demographics.ageYears ?? 'unknown'}, sex ${demographics.sex ?? 'unrecorded'}.`,
    `COVERAGE: ${coverage?.payer ?? 'self-pay'}${coverage?.memberId ? `, member ${coverage.memberId}` : ''}.`,
    `VITALS: ${
      [
        v.height && `height ${v.height.display}`,
        v.weight && `weight ${v.weight.display}`,
        v.bmi && `BMI ${v.bmi.display} (${v.bmi.category})`,
        v.bloodPressure && `blood pressure ${v.bloodPressure.display}`,
        v.heartRate && `heart rate ${v.heartRate.display}`,
      ]
        .filter(Boolean)
        .join(', ') || 'none on file'
    }.`,
    `ENCOUNTERS (${record.encounters.length}): ${
      record.encounters.map((e) => `${e.type?.[0]?.text ?? 'visit'} [${e.status}]`).join('; ') || 'none'
    }`,
    `CLAIMS (${record.claims.length}): ${
      record.claims.map((c) => `${c.item?.[0]?.productOrService?.text ?? 'claim'} [${c.status}]`).join('; ') || 'none'
    }`,
    `DENIALS: ${record.responses.filter((r) => r.outcome === 'error').map((r) => r.disposition ?? 'denied').join('; ') || 'none'}`,
    `OPEN ORDERS: ${facts.openOrders.join('; ') || 'none'}`,
    `NEXT VISIT: ${facts.nextAppointment ?? 'none booked'}`,
    `DOCUMENTS ON FILE: ${facts.documentCount}`,
  ].join('\n');
}

/** Everything `/patients?p=<id>` renders. Undefined when the id is unknown. */
export async function patientChart(patientId: string, store?: FhirStore): Promise<PatientChart | undefined> {
  const db = store ?? (await getStore());
  const ref = `Patient/${patientId}`;

  const [record, coverages, observations, documents] = await Promise.all([
    patientRecord(patientId, db),
    db.search<Coverage>('Coverage', { beneficiary: ref }),
    db.search<Observation>('Observation', { subject: ref }),
    db.search<DocumentReference>('DocumentReference', { subject: ref }),
  ]);
  if (!record) return undefined;

  const demographics = demographicsFrom(record.patient);
  const coverage = coverageFrom(coverages[0]);
  const chartDocuments = chartDocumentsFrom(documents, MAX_INLINE_TEXT);
  const facts = factsFrom(record, demographics, coverage, observations, chartDocuments.length);

  const fingerprint = overviewFingerprint({
    patientId,
    vitalsObservedAt: facts.vitals.observedAt,
    encounterCount: record.encounters.length,
    claimCount: record.claims.length,
    responseCount: record.responses.length,
    openOrderCount: facts.openOrders.length,
    nextAppointmentStart: record.appointments.find((a) => a.status !== 'cancelled')?.start,
    payer: coverage?.payer,
    documentCount: chartDocuments.length,
  });
  const cached = await readOverviewRecord(patientId, db);

  const related: Resource[] = [
    ...coverages,
    ...record.encounters,
    ...record.serviceRequests,
    ...record.claims,
    ...record.responses,
    ...record.tasks,
    ...record.communications,
    ...observations,
    ...documents,
  ];

  const inventory = inventoryFrom(related);

  return {
    demographics,
    coverage,
    vitals: facts.vitals,
    appointments: splitAppointments(record.appointments),
    overview: overviewFrom(cached, fingerprint, facts),
    documents: chartDocuments,
    journey: timelineFrom(record),
    fhir: {
      counts: { Patient: 1, ...inventory.counts },
      entries: [toFhirEntry(record.patient), ...inventory.entries],
    },
  };
}

/**
 * The chart as the copilot receives it.
 *
 * Values come back in full, per the "Patient information" contract in
 * copilotPrompt.ts: this is an internal tool serving staff who already hold the
 * chart, so identifiers are not shortened here and must not be shortened in the
 * answer either. What is deliberately left out is bulk — raw resource JSON, and
 * the journey beyond its most recent entries — because that is context cost,
 * not policy.
 */
export async function chartForAgent(patientId: string, store?: FhirStore) {
  const chart = await patientChart(patientId, store);
  if (!chart) return undefined;
  const { demographics: d, coverage, vitals } = chart;
  return {
    patientId: d.id,
    patient: d.name,
    ageYears: d.ageYears,
    sex: d.sex,
    dob: d.dob,
    mrn: d.mrn,
    phone: d.phone,
    email: d.email,
    address: d.address,
    coverage: coverage && {
      payer: coverage.payer,
      memberId: coverage.memberId,
      groupNumber: coverage.groupNumber,
      status: coverage.status,
    },
    vitals: {
      height: vitals.height?.display,
      weight: vitals.weight?.display,
      bmi: vitals.bmi && `${vitals.bmi.display} (${vitals.bmi.category})`,
      bloodPressure: vitals.bloodPressure?.display,
      heartRate: vitals.heartRate?.display,
      observedAt: vitals.observedAt,
    },
    appointments: [...chart.appointments.upcoming, ...chart.appointments.past].map((a) => ({
      handle: a.handle,
      what: a.description,
      when: `${a.dayLabel} ${a.timeLabel}`,
      status: a.status,
    })),
    overview: { text: chart.overview.text, stale: chart.overview.stale, engine: chart.overview.engine },
    documents: chart.documents.map((doc) => ({
      title: doc.title,
      origin: doc.origin,
      fields: doc.fields,
      redactedRegions: doc.redactedRegions,
      filedAt: doc.createdAt,
    })),
    journey: chart.journey.slice(0, 20).map((e) => ({ at: e.at, kind: e.kind, what: e.title })),
    fhirCounts: chart.fhir.counts,
  };
}

/** Rebuild and cache this patient's overview. The one chart path that calls a model. */
export async function regeneratePatientOverview(patientId: string, store?: FhirStore) {
  const db = store ?? (await getStore());
  const ref = `Patient/${patientId}`;
  const [record, coverages, observations, documents] = await Promise.all([
    patientRecord(patientId, db),
    db.search<Coverage>('Coverage', { beneficiary: ref }),
    db.search<Observation>('Observation', { subject: ref }),
    db.search<DocumentReference>('DocumentReference', { subject: ref }),
  ]);
  if (!record) return undefined;

  const demographics = demographicsFrom(record.patient);
  const coverage = coverageFrom(coverages[0]);
  const documentCount = chartDocumentsFrom(documents, MAX_INLINE_TEXT).length;
  const facts = factsFrom(record, demographics, coverage, observations, documentCount);

  return generateOverview({
    patient: record.patient,
    coverage: coverages[0],
    contextText: chartAsText(demographics, coverage, facts, record),
    facts,
    fingerprint: overviewFingerprint({
      patientId,
      vitalsObservedAt: facts.vitals.observedAt,
      encounterCount: record.encounters.length,
      claimCount: record.claims.length,
      responseCount: record.responses.length,
      openOrderCount: facts.openOrders.length,
      nextAppointmentStart: record.appointments.find((a) => a.status !== 'cancelled')?.start,
      payer: coverage?.payer,
      documentCount,
    }),
    store: db,
  });
}
