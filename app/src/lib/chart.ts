/**
 * The client's contract for a patient chart. `patientChart()` in
 * patientChart.server.ts satisfies this structurally, so the chart UI never has
 * to import a `server-only` module to get its types — the same arrangement
 * calendar.ts has with appointments.server.ts.
 *
 * Everything derived — age, BMI, unit conversion, slot strings, resource JSON —
 * is computed on the server against one clock and one timezone. The panels only
 * ever render, because `force-dynamic` pages that do date or unit math in a
 * component hydrate differently than they rendered.
 */

/** Administrative sex as recorded on Patient.gender. */
export type PatientSex = 'male' | 'female' | 'other' | 'unknown';

export interface Demographics {
  id: string;
  name: string;
  mrn?: string;
  sex?: PatientSex;
  dob?: string;
  ageYears?: number;
  phone?: string;
  email?: string;
  /** Pre-joined to one line: "123 Harbor Lane, Oakland, CA 94607". */
  address?: string;
}

export interface CoverageCard {
  id: string;
  payer: string;
  memberId?: string;
  groupNumber?: string;
  planName?: string;
  status?: string;
}

export interface VitalReading {
  /** Canonical metric value as stored (cm, kg, /min). */
  value: number;
  /** UCUM code as stored. */
  unit: string;
  /** What the chart shows: `5' 6"`, "148 lb", "72 bpm". */
  display: string;
  observedAt?: string;
  observationId: string;
}

export interface BloodPressureReading {
  systolic: number;
  diastolic: number;
  unit: string;
  /** "128/82" */
  display: string;
  observedAt?: string;
  observationId: string;
}

export interface BmiReading {
  value: number;
  /** "23.9" */
  display: string;
  /** underweight | normal | overweight | obese — plain words, not a code. */
  category: string;
}

export interface VitalsPanel {
  height?: VitalReading;
  weight?: VitalReading;
  bloodPressure?: BloodPressureReading;
  heartRate?: VitalReading;
  /** Derived from height + weight, never stored — a stored BMI goes stale. */
  bmi?: BmiReading;
  /** Newest reading across the panel: the "as of" for the whole block. */
  observedAt?: string;
}

export interface ChartAppointment {
  id: string;
  handle: string;
  description: string;
  /** "Aug 11" */
  dayLabel: string;
  /** "10:00 AM – 11:00 AM" */
  timeLabel: string;
  status: string;
  /** Raw source code; the UI calls bookedByLabel() from calendar.ts. */
  bookedBy: string;
}

export type OverviewEngine = 'anthropic' | 'template';

export interface PatientOverview {
  text: string;
  engine: OverviewEngine;
  /** Undefined for the on-the-fly template — nothing was cached. */
  generatedAt?: string;
  /** True when the chart changed after this text was written. */
  stale: boolean;
  /** PHI values tokenized before the model saw the chart. */
  redactionCount?: number;
}

export interface ChartDocument {
  id: string;
  title: string;
  description?: string;
  /** 'agent' = written by the pipeline; 'upload' = handed over at the front desk. */
  origin: 'agent' | 'upload';
  contentType: string;
  /** Bytes live behind this URL, never inline — the page re-renders every few seconds. */
  contentUrl: string;
  /** Inlined for small text artifacts only (the prior-auth packet), capped. */
  text?: string;
  /** Masked chips from describeForPanel(): "member ID: ••••6789". */
  fields?: string[];
  redactedRegions?: number;
  sizeLabel?: string;
  createdAt: string;
}

export interface FhirEntry {
  /** "Encounter/abc" */
  reference: string;
  resourceType: string;
  /** One human line for the row header. */
  display: string;
  lastUpdated?: string;
  /** Pre-stringified, with DocumentReference attachment bytes stripped. */
  json: string;
}

export interface FhirInventory {
  counts: Record<string, number>;
  entries: FhirEntry[];
}

/** One event on the patient's journey. */
export interface TimelineEvent {
  at: string;
  kind:
    | 'intake'
    | 'encounter'
    | 'order'
    | 'claim'
    | 'denial'
    | 'approval'
    | 'agent'
    | 'appointment'
    | 'message';
  title: string;
  detail?: string;
  badge?: { label: string; tone: 'good' | 'bad' | 'neutral' | 'accent' };
}

/** Everything `/patients?p=<id>` renders, in one object. */
export interface PatientChart {
  demographics: Demographics;
  coverage?: CoverageCard;
  vitals: VitalsPanel;
  appointments: { upcoming: ChartAppointment[]; past: ChartAppointment[] };
  overview: PatientOverview;
  documents: ChartDocument[];
  journey: TimelineEvent[];
  fhir: FhirInventory;
}

/** "Aug 4 · 10:32 AM" — the one date format the patient UI uses. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** "JD" — the two-letter avatar label. */
export function initials(name: string): string {
  return name.split(' ').map((w) => w[0]).slice(0, 2).join('');
}
