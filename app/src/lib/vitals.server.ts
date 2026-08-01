import 'server-only';
import type { Observation, Patient } from '@medplum/fhirtypes';
import { getStore, writeAudit, type FhirStore } from './medplum.server';
import { findPatientByName, patientDisplayName, PatientError } from './patients.server';
import type { BloodPressureReading, BmiReading, VitalReading, VitalsPanel } from './chart';

/**
 * THE vital signs module: every Observation this app writes or reads is shaped
 * here, so the copilot tool, the seed scripts and the chart can't disagree.
 *
 * Values are stored in metric (cm, kg, mm[Hg], /min) without exception. That is
 * the canonical unit set of the FHIR vital-signs profile, it is what the BMI
 * formula wants, and it means a real Medplum project or any future FHIR
 * consumer reads them correctly. US-customary is a display concern and lives
 * only in formatHeight/formatWeight; it is normalised away at the edge of
 * recordVitals and never appears in the interior.
 *
 * Search note (same trap as appointments.server.ts): Observations are fetched
 * with `subject` ONLY. The memory store's matches() understands a fixed param
 * list and silently returns [] for `category`, so category filtering happens in
 * JS. Never add a param here without checking medplum.server.ts first.
 */

const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/observation-category';
const IDS = 'https://autonomous-backoffice.dev/demo';

export const VITAL_CODES = {
  height: '8302-2',
  weight: '29463-7',
  bloodPressure: '85354-9',
  heartRate: '8867-4',
} as const;

const SYSTOLIC_CODE = '8480-6';
const DIASTOLIC_CODE = '8462-4';

// Ranges a human could plausibly have. Anything outside is a typo, not a reading.
const LIMITS = {
  heightCm: [30, 275],
  weightKg: [1, 650],
  systolic: [50, 300],
  diastolic: [20, 200],
  heartRate: [20, 300],
} as const;

export interface VitalsInput {
  heightCm?: number;
  heightIn?: number;
  weightKg?: number;
  weightLb?: number;
  systolic?: number;
  diastolic?: number;
  heartRate?: number;
  observedAt?: string;
}

/** `5' 6"` — feet and inches, carrying 12" up so nobody is ever 5' 12". */
export function formatHeight(cm: number): string {
  const totalInches = Math.round(cm / 2.54);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}' ${inches}"`;
}

/** "148 lb" — the unit US clinic staff actually say out loud. */
export function formatWeight(kg: number): string {
  return `${Math.round(kg * 2.20462)} lb`;
}

/** BMI from the metric pair, with the plain-word category clinicians use. */
export function deriveBmi(heightCm: number, weightKg: number): BmiReading {
  const metres = heightCm / 100;
  const value = weightKg / (metres * metres);
  const rounded = Math.round(value * 10) / 10;
  const category =
    rounded < 18.5 ? 'underweight' : rounded < 25 ? 'normal' : rounded < 30 ? 'overweight' : 'obese';
  return { value: rounded, display: rounded.toFixed(1), category };
}

function observedAtOf(o: Observation): string | undefined {
  return o.effectiveDateTime ?? o.meta?.lastUpdated;
}

/** The newest Observation carrying `code`, or undefined. */
function newest(observations: Observation[], code: string): Observation | undefined {
  return observations
    .filter((o) => o.code?.coding?.some((c) => c.code === code))
    .sort((a, b) => (observedAtOf(b) ?? '').localeCompare(observedAtOf(a) ?? ''))[0];
}

function readingFrom(o: Observation | undefined, display: (value: number) => string): VitalReading | undefined {
  const value = o?.valueQuantity?.value;
  if (o?.id === undefined || value === undefined) return undefined;
  return {
    value,
    unit: o.valueQuantity?.code ?? o.valueQuantity?.unit ?? '',
    display: display(value),
    observedAt: observedAtOf(o),
    observationId: o.id,
  };
}

function bloodPressureFrom(o: Observation | undefined): BloodPressureReading | undefined {
  if (!o?.id) return undefined;
  const componentValue = (code: string): number | undefined =>
    o.component?.find((c) => c.code?.coding?.some((x) => x.code === code))?.valueQuantity?.value;
  const systolic = componentValue(SYSTOLIC_CODE);
  const diastolic = componentValue(DIASTOLIC_CODE);
  if (systolic === undefined || diastolic === undefined) return undefined;
  return {
    systolic,
    diastolic,
    unit: 'mm[Hg]',
    display: `${systolic}/${diastolic}`,
    observedAt: observedAtOf(o),
    observationId: o.id,
  };
}

/** Pure: the latest of each vital sign, from a patient's Observations. */
export function vitalsFrom(observations: Observation[]): VitalsPanel {
  const vitals = observations.filter((o) =>
    o.category?.some((c) => c.coding?.some((x) => x.code === 'vital-signs')),
  );

  const height = readingFrom(newest(vitals, VITAL_CODES.height), formatHeight);
  const weight = readingFrom(newest(vitals, VITAL_CODES.weight), formatWeight);
  const bloodPressure = bloodPressureFrom(newest(vitals, VITAL_CODES.bloodPressure));
  const heartRate = readingFrom(newest(vitals, VITAL_CODES.heartRate), (v) => `${Math.round(v)} bpm`);
  const bmi = height && weight ? deriveBmi(height.value, weight.value) : undefined;

  const observedAt = [height, weight, bloodPressure, heartRate]
    .map((r) => r?.observedAt)
    .filter((at): at is string => Boolean(at))
    .sort((a, b) => b.localeCompare(a))[0];

  return { height, weight, bloodPressure, heartRate, bmi, observedAt };
}

/** Latest vitals for one patient. */
export async function latestVitals(patientId: string, store?: FhirStore): Promise<VitalsPanel> {
  const db = store ?? (await getStore());
  const observations = await db.search<Observation>('Observation', { subject: `Patient/${patientId}` });
  return vitalsFrom(observations);
}

function requireRange(label: string, value: number, [min, max]: readonly [number, number]): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new PatientError('invalid_input', `${label} of ${value} is outside the plausible range ${min}–${max}.`);
  }
}

/** Metric truth from whatever units the caller had. */
function normalise(vitals: VitalsInput): {
  heightCm?: number;
  weightKg?: number;
  systolic?: number;
  diastolic?: number;
  heartRate?: number;
} {
  const heightCm = vitals.heightCm ?? (vitals.heightIn !== undefined ? vitals.heightIn * 2.54 : undefined);
  const weightKg = vitals.weightKg ?? (vitals.weightLb !== undefined ? vitals.weightLb / 2.20462 : undefined);

  if (heightCm !== undefined) requireRange('Height', heightCm, LIMITS.heightCm);
  if (weightKg !== undefined) requireRange('Weight', weightKg, LIMITS.weightKg);
  if (vitals.heartRate !== undefined) requireRange('Heart rate', vitals.heartRate, LIMITS.heartRate);

  // A half-recorded blood pressure is worse than none — it reads as a real value.
  if ((vitals.systolic === undefined) !== (vitals.diastolic === undefined)) {
    throw new PatientError('invalid_input', 'Blood pressure needs both a systolic and a diastolic value.');
  }
  if (vitals.systolic !== undefined) requireRange('Systolic', vitals.systolic, LIMITS.systolic);
  if (vitals.diastolic !== undefined) requireRange('Diastolic', vitals.diastolic, LIMITS.diastolic);

  return { heightCm, weightKg, systolic: vitals.systolic, diastolic: vitals.diastolic, heartRate: vitals.heartRate };
}

function quantityObservation(opts: {
  patientRef: string;
  code: string;
  display: string;
  text: string;
  value: number;
  unit: string;
  observedAt: string;
  identifier?: string;
}): Observation {
  return {
    resourceType: 'Observation',
    status: 'final',
    category: [{ coding: [{ system: CATEGORY_SYSTEM, code: 'vital-signs', display: 'Vital Signs' }] }],
    code: { coding: [{ system: LOINC, code: opts.code, display: opts.display }], text: opts.text },
    subject: { reference: opts.patientRef },
    effectiveDateTime: opts.observedAt,
    valueQuantity: { value: Math.round(opts.value * 10) / 10, unit: opts.unit, system: UCUM, code: opts.unit },
    identifier: opts.identifier ? [{ system: IDS, value: opts.identifier }] : undefined,
  };
}

/**
 * THE place a vital sign is written — the copilot tool, the API boundary and
 * both seed scripts call this, so the Observation shape exists exactly once.
 *
 * `identifierPrefix` turns the write into an upsert-by-identifier, which is what
 * the idempotent seeds need. Without it every call appends a new reading, which
 * is what a time series wants.
 */
export async function recordVitals(opts: {
  patientId?: string;
  patientName?: string;
  vitals: VitalsInput;
  identifierPrefix?: string;
  store?: FhirStore;
}): Promise<{ panel: VitalsPanel; summary: string; written: number }> {
  const db = opts.store ?? (await getStore());
  const patient = opts.patientId
    ? await db.read<Patient>('Patient', opts.patientId)
    : opts.patientName
      ? await findPatientByName(db, opts.patientName)
      : undefined;
  if (!patient?.id) {
    throw new PatientError('not_found', `No patient matched ${opts.patientName ?? opts.patientId ?? 'that request'}.`);
  }

  const { heightCm, weightKg, systolic, diastolic, heartRate } = normalise(opts.vitals);
  const patientRef = `Patient/${patient.id}`;
  const observedAt = opts.vitals.observedAt ?? new Date().toISOString();
  const pending: Observation[] = [];

  if (heightCm !== undefined) {
    pending.push(
      quantityObservation({
        patientRef, code: VITAL_CODES.height, display: 'Body height', text: 'Height',
        value: heightCm, unit: 'cm', observedAt,
        identifier: opts.identifierPrefix && `${opts.identifierPrefix}-${VITAL_CODES.height}`,
      }),
    );
  }
  if (weightKg !== undefined) {
    pending.push(
      quantityObservation({
        patientRef, code: VITAL_CODES.weight, display: 'Body weight', text: 'Weight',
        value: weightKg, unit: 'kg', observedAt,
        identifier: opts.identifierPrefix && `${opts.identifierPrefix}-${VITAL_CODES.weight}`,
      }),
    );
  }
  if (heartRate !== undefined) {
    pending.push(
      quantityObservation({
        patientRef, code: VITAL_CODES.heartRate, display: 'Heart rate', text: 'Heart rate',
        value: heartRate, unit: '/min', observedAt,
        identifier: opts.identifierPrefix && `${opts.identifierPrefix}-${VITAL_CODES.heartRate}`,
      }),
    );
  }
  // One Observation with two components, never two siblings — a reading can
  // then never half-exist.
  if (systolic !== undefined && diastolic !== undefined) {
    pending.push({
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: CATEGORY_SYSTEM, code: 'vital-signs', display: 'Vital Signs' }] }],
      code: {
        coding: [{ system: LOINC, code: VITAL_CODES.bloodPressure, display: 'Blood pressure panel' }],
        text: 'Blood pressure',
      },
      subject: { reference: patientRef },
      effectiveDateTime: observedAt,
      component: [
        {
          code: { coding: [{ system: LOINC, code: SYSTOLIC_CODE, display: 'Systolic blood pressure' }] },
          valueQuantity: { value: systolic, unit: 'mm[Hg]', system: UCUM, code: 'mm[Hg]' },
        },
        {
          code: { coding: [{ system: LOINC, code: DIASTOLIC_CODE, display: 'Diastolic blood pressure' }] },
          valueQuantity: { value: diastolic, unit: 'mm[Hg]', system: UCUM, code: 'mm[Hg]' },
        },
      ],
      identifier: opts.identifierPrefix
        ? [{ system: IDS, value: `${opts.identifierPrefix}-${VITAL_CODES.bloodPressure}` }]
        : undefined,
    });
  }

  if (pending.length === 0) {
    throw new PatientError('invalid_input', 'No vital signs were given to record.');
  }

  for (const observation of pending) {
    const identifier = observation.identifier?.[0]?.value;
    const existing = identifier ? (await db.search<Observation>('Observation', { identifier }))[0] : undefined;
    if (existing?.id) {
      await db.update<Observation>({ ...observation, id: existing.id });
    } else {
      await db.create<Observation>(observation);
    }
  }

  const panel = await latestVitals(patient.id, db);
  const parts = [
    panel.height && `height ${panel.height.display}`,
    panel.weight && `weight ${panel.weight.display}`,
    panel.bmi && `BMI ${panel.bmi.display}`,
    panel.bloodPressure && `BP ${panel.bloodPressure.display}`,
    panel.heartRate && `heart rate ${panel.heartRate.display}`,
  ].filter(Boolean);

  await writeAudit(db, {
    subtype: 'vitals-recorded',
    description: `${pending.length} vital sign(s) recorded for ${patientDisplayName(patient)}`,
    entities: [patientRef],
  });

  return {
    panel,
    written: pending.length,
    summary: `Recorded for ${patientDisplayName(patient)}: ${parts.join(', ')}.`,
  };
}
