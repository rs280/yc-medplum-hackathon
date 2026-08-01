import 'server-only';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Basic, Coverage, Patient } from '@medplum/fhirtypes';
import type { OverviewEngine, PatientOverview, VitalsPanel } from './chart';
import { deredact } from './deredact';
import { getLlmClient, reasonModelId } from './llmClient';
import { getStore, writeAudit, type FhirStore } from './medplum.server';
import { releaseRun, startRedaction } from './redact';
import type { Redacted } from '@/types/redacted';

/**
 * The AI overview on the Summary tab: a short paragraph orienting whoever just
 * opened the chart.
 *
 * Two rules shape this whole module.
 *
 * 1. The page re-renders every few seconds, so reading a chart must NEVER call
 *    a model. The text is cached in FHIR and regeneration is always an explicit
 *    write — a stale overview says so and offers a refresh, rather than quietly
 *    rewriting itself on screen six times a minute.
 * 2. The redaction guarantee holds here exactly as it does in the pipeline:
 *    overviewText() accepts only `Redacted`, so handing it a raw chart string is
 *    a compile error, and the result goes through fail-closed de-redaction.
 */

const OVERVIEW_SYSTEM = 'https://backoffice.local/patient-overview';
const EXT_URL = `${OVERVIEW_SYSTEM}/record`;
const MAX_CHARS = 900;

/** Non-identifying facts. The template fallback runs on these alone. */
export interface OverviewFacts {
  ageYears?: number;
  sex?: string;
  payer?: string;
  vitals: VitalsPanel;
  encounterCount: number;
  claimCount: number;
  denialCount: number;
  openOrders: string[];
  nextAppointment?: string;
  documentCount: number;
}

interface OverviewRecord {
  text: string;
  engine: OverviewEngine;
  generatedAt: string;
  /** Change detector — regenerate only when the inputs actually moved. */
  fingerprint: string;
  redactionCount: number;
}

const SYSTEM_PROMPT = `You write the one-paragraph orientation note at the top of a patient's chart, for a clinician or front-desk staffer who has just opened it.

Write four to six sentences of continuous prose. No markdown, no headers, no lists, no bold.

Cover, in this order and only where the context supports it: who this patient is clinically, what their vital signs say, what is open right now (overdue screenings, pending authorizations, denied claims, upcoming visits), and what happens next.

Rules you must follow:
- Refer to the person as "the patient". Never write a name, and never write a placeholder token like [NAME_1] even if one appears in the context — write "the patient" instead.
- State facts from the context. Do not diagnose, do not recommend treatment, and do not infer conditions that are not written down.
- Where something important is missing, say so plainly: "no vital signs are on file".
- Ages, sexes, dates, measurements and insurance names are all fine to state.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: { overview: { type: 'string' } },
  required: ['overview'],
  additionalProperties: false,
};

/** A stable digest of everything the overview is written from. */
export function overviewFingerprint(parts: {
  patientId: string;
  vitalsObservedAt?: string;
  encounterCount: number;
  claimCount: number;
  responseCount: number;
  openOrderCount: number;
  nextAppointmentStart?: string;
  payer?: string;
  documentCount: number;
}): string {
  const raw = [
    parts.patientId,
    parts.vitalsObservedAt ?? '',
    parts.encounterCount,
    parts.claimCount,
    parts.responseCount,
    parts.openOrderCount,
    parts.nextAppointmentStart ?? '',
    parts.payer ?? '',
    parts.documentCount,
  ].join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

/**
 * The LLM half. Takes `Redacted`, so passing a raw chart string is a compile
 * error — this signature is the guarantee, not the comment above it.
 */
export async function overviewText(
  context: Redacted,
  facts: OverviewFacts,
): Promise<{ text: string; engine: OverviewEngine }> {
  const client = getLlmClient();
  if (!client) return { text: templateOverview(facts), engine: 'template' };

  try {
    const response = await client.messages.create({
      model: reasonModelId(),
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: (process.env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high') || 'low',
        format: { type: 'json_schema', schema: RESPONSE_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [{ role: 'user', content: `DE-IDENTIFIED CHART:\n${context}` }],
    });
    if (response.stop_reason === 'refusal') {
      console.warn('[overview] model refusal — falling back to template');
      return { text: templateOverview(facts), engine: 'template' };
    }
    const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = JSON.parse(raw) as { overview?: string };
    const text = parsed.overview?.trim();
    if (!text) return { text: templateOverview(facts), engine: 'template' };
    return { text: text.slice(0, MAX_CHARS), engine: 'anthropic' };
  } catch (err) {
    console.warn('[overview] LLM call failed — falling back to template:', err);
    return { text: templateOverview(facts), engine: 'template' };
  }
}

/** Deterministic prose from the non-identifying facts, for when no LLM is configured. */
export function templateOverview(facts: OverviewFacts): string {
  const who = [facts.ageYears != null && `${facts.ageYears}-year-old`, facts.sex].filter(Boolean).join(' ');
  const lines: string[] = [
    who ? `The patient is a ${who} on the clinic panel.` : 'The patient is on the clinic panel.',
    facts.payer ? `Coverage is with ${facts.payer}.` : 'No insurance coverage is on file.',
  ];

  const vitals = [
    facts.vitals.height && `height ${facts.vitals.height.display}`,
    facts.vitals.weight && `weight ${facts.vitals.weight.display}`,
    facts.vitals.bmi && `BMI ${facts.vitals.bmi.display} (${facts.vitals.bmi.category})`,
    facts.vitals.bloodPressure && `blood pressure ${facts.vitals.bloodPressure.display}`,
  ].filter(Boolean);
  lines.push(vitals.length > 0 ? `Latest vitals: ${vitals.join(', ')}.` : 'No vital signs are on file yet.');

  lines.push(
    `The record holds ${facts.encounterCount} encounter(s) and ${facts.claimCount} claim(s)` +
      (facts.denialCount > 0 ? `, ${facts.denialCount} of which came back denied.` : '.'),
  );
  if (facts.openOrders.length > 0) lines.push(`Open orders: ${facts.openOrders.join(', ')}.`);
  if (facts.nextAppointment) lines.push(`Next visit: ${facts.nextAppointment}.`);

  return lines.join(' ');
}

function overviewIdentifier(patientId: string): string {
  return `overview-${patientId}`;
}

async function findOverviewResource(db: FhirStore, patientId: string): Promise<Basic | undefined> {
  const found = await db.search<Basic>('Basic', { identifier: overviewIdentifier(patientId), _count: '1' });
  return found[0];
}

/** The cached overview record for a patient, or undefined when none was ever written. */
export async function readOverviewRecord(patientId: string, db: FhirStore): Promise<OverviewRecord | undefined> {
  const resource = await findOverviewResource(db, patientId);
  const raw = resource?.extension?.find((e) => e.url === EXT_URL)?.valueString;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as OverviewRecord;
  } catch {
    return undefined;
  }
}

/** The overview as the chart renders it: cached text if present, else a live template. */
export function overviewFrom(
  cached: OverviewRecord | undefined,
  currentFingerprint: string,
  facts: OverviewFacts,
): PatientOverview {
  if (!cached) {
    // Nothing generated yet — show something useful rather than an empty box,
    // and do NOT persist it, so a template can never masquerade as a cache hit.
    return { text: templateOverview(facts), engine: 'template', stale: false };
  }
  return {
    text: cached.text,
    engine: cached.engine,
    generatedAt: cached.generatedAt,
    stale: cached.fingerprint !== currentFingerprint,
    redactionCount: cached.redactionCount,
  };
}

/**
 * Rebuild and cache the overview. The ONLY function in the chart that calls a
 * model, and it runs only when someone explicitly asks for it.
 */
export async function generateOverview(opts: {
  patient: Patient;
  coverage?: Coverage;
  contextText: string;
  facts: OverviewFacts;
  fingerprint: string;
  store?: FhirStore;
}): Promise<PatientOverview> {
  const db = opts.store ?? (await getStore());
  const patientId = opts.patient.id!;
  const runId = randomUUID();

  try {
    const session = startRedaction(runId, [opts.patient, opts.coverage]);
    const context = session.redact(opts.contextText);
    const { text, engine } = await overviewText(context, opts.facts);

    // Normally a no-op: the prompt forbids emitting tokens. It stays mandatory
    // and fail-closed because it is the enforcement that the model did not echo
    // or invent one.
    const final = deredact(runId, text);

    // A template is never cached — caching one buys a stale-cache bug class for
    // no value, since it is cheap to rebuild on every render.
    if (engine !== 'anthropic') {
      return { text: final, engine, stale: false };
    }

    const record: OverviewRecord = {
      text: final,
      engine,
      generatedAt: new Date().toISOString(),
      fingerprint: opts.fingerprint,
      redactionCount: session.replacements,
    };
    await saveOverview(db, patientId, record);
    await writeAudit(db, {
      subtype: 'patient-overview',
      description: `Chart overview generated; ${session.replacements} PHI value(s) tokenized before the model saw it`,
      entities: [`Patient/${patientId}`],
    });
    return {
      text: record.text,
      engine: record.engine,
      generatedAt: record.generatedAt,
      stale: false,
      redactionCount: record.redactionCount,
    };
  } catch (err) {
    // Fail closed: keep whatever was cached rather than persist half-redacted text.
    console.error('[overview] generation failed:', err);
    await writeAudit(db, {
      subtype: 'patient-overview',
      outcome: '8',
      description: `Chart overview generation failed: ${err instanceof Error ? err.message : String(err)}`,
      entities: [`Patient/${patientId}`],
    });
    const cached = await readOverviewRecord(patientId, db);
    if (cached) {
      return {
        text: cached.text,
        engine: cached.engine,
        generatedAt: cached.generatedAt,
        stale: cached.fingerprint !== opts.fingerprint,
        redactionCount: cached.redactionCount,
      };
    }
    return { text: templateOverview(opts.facts), engine: 'template', stale: false };
  } finally {
    releaseRun(runId);
  }
}

async function saveOverview(db: FhirStore, patientId: string, record: OverviewRecord): Promise<void> {
  const existing = await findOverviewResource(db, patientId);
  const resource: Basic = {
    ...(existing ?? {}),
    resourceType: 'Basic',
    identifier: [{ system: OVERVIEW_SYSTEM, value: overviewIdentifier(patientId) }],
    code: { coding: [{ system: OVERVIEW_SYSTEM, code: 'patient-overview', display: 'Patient overview' }] },
    subject: { reference: `Patient/${patientId}` },
    extension: [{ url: EXT_URL, valueString: JSON.stringify(record) }],
  };
  if (existing?.id) {
    await db.update(resource);
  } else {
    await db.create(resource);
  }
}
