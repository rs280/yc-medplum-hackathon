import { NextResponse, type NextRequest } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';
import { copilotSystemPrompt, patientCopilotSystemPrompt } from '@/lib/copilotPrompt';
import { patientPortal } from '@/lib/workspace.server';
import { getLlmClient, resolveChatModel } from '@/lib/llmClient';
import {
  bookAppointment,
  cancelAppointment,
  CLINIC_TIME_ZONE,
  formatSlot,
  listCalendar,
  rescheduleAppointment,
} from '@/lib/appointments.server';
import { todayKey, zonedIso } from '@/lib/calendar';
import {
  checkCoverage,
  completeVisit,
  DENIAL_TEXTS,
  orderScan,
  fireEvent,
  latestArtifact,
  recentRuns,
  statusSnapshot,
  type CopilotEvent,
} from '@/lib/copilot.server';
import { chartForAgent, regeneratePatientOverview } from '@/lib/patientChart.server';
import {
  addClinicalNote,
  findPatientByName,
  patientDisplayName,
  registerPatient,
  requirePatient,
  updateCoverage,
  updateDemographics,
} from '@/lib/patients.server';
import { getStore } from '@/lib/medplum.server';
import { recordVitals } from '@/lib/vitals.server';
import {
  describeForAgent,
  describeForPanel,
  readPatientDocument,
  type AttachedImage,
} from '@/lib/documentRedaction.server';
import { approveDraft, listPending, rejectDraft } from '@/lib/approvals.server';
import { CRITERIA_INDEX, PLAYBOOK_INDEX, mossSearch } from '@/lib/moss.server';
import type { PipelineStepEvent } from '@/lib/pipeline';
import { searchPubMed } from '@/lib/pubmed.server';
import type { Redacted } from '@/types/redacted';
import type { Patient } from '@medplum/fhirtypes';

export const maxDuration = 300;

/**
 * Back-office copilot: an agentic chat endpoint for clinicians and front-desk
 * staff. Streams NDJSON events ({type:'text'|'tool'|'done'|'error'}) so the
 * UI can render Cursor-style tool steps live. The copilot only ever sees
 * redacted/aggregate data; run_agent drives the real pipeline in-process.
 * Without an LLM key (OPENROUTER_API_KEY or ANTHROPIC_API_KEY) a keyword-router
 * fallback handles the same commands so the demo never blocks.
 *
 * An attached image is read once by the redaction pass before the agent loop
 * starts; only the boxes and the extracted fields go forward, never the image.
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type Emit = (event: Record<string, unknown>) => void;

const IMAGE_MEDIA_TYPES: ReadonlyArray<AttachedImage['mediaType']> = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

// 12 MB of bytes, which base64 inflates by about a third.
const MAX_BASE64_LENGTH = 17 * 1024 * 1024;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_status',
    description:
      'Snapshot of the whole back office: integration modes, appeal win rate, PHI tokens redacted, care gaps closed, run count, and the learned playbook. Call this for "how are we doing", "status", "win rate".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_runs',
    description: 'Recent pipeline runs (redacted summaries): agent, decision, outcome, sources cited, latency.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max runs to return (default 10)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_artifact',
    description:
      'Fetch the redacted artifact (appeal letter, prior-auth packet, outreach script) from the latest run, or a specific run by runId.',
    input_schema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Optional run id (prefix ok)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'register_patient',
    description:
      'Front desk: register a brand-new patient and verify their insurance eligibility (270/271). Creates the medical record and coverage. Requires at least a name and an insurance company.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name, e.g. "Jordan Lee"' },
        birthDate: { type: 'string', description: 'YYYY-MM-DD if given' },
        phone: { type: 'string' },
        payer: { type: 'string', description: 'Insurance company, e.g. Aetna, Blue Shield PPO, Medicare' },
        memberId: { type: 'string', description: 'Insurance member ID if given' },
      },
      required: ['name', 'payer'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_coverage',
    description:
      'Look up a registered patient\'s insurance and run a live 270/271 eligibility check. Call for "what\'s my coverage", "am I insured", "does my plan cover this".',
    input_schema: {
      type: 'object',
      properties: { patientName: { type: 'string' } },
      required: ['patientName'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_appointment',
    description:
      'Front desk: book a visit for a registered patient. Compute startIso from the user’s words and today’s date, and include the clinic timezone offset. Omit startIso for tomorrow 10:00.',
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        description: { type: 'string', description: 'e.g. "New patient check-up"' },
        startIso: {
          type: 'string',
          description: 'ISO 8601 start with offset, e.g. 2026-08-04T10:00:00-07:00',
        },
        minutes: { type: 'integer', description: 'Visit length in minutes (default 30)' },
      },
      required: ['patientName'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_appointments',
    description:
      'Read the clinic calendar. Returns each visit with a short handle like APT-4F2A — that handle is how you cancel or move it. Call this for "what is on Tuesday", "is Maria booked", "how busy are we this week", and ALWAYS before cancelling or rescheduling unless you already have the handle from earlier in this conversation.',
    input_schema: {
      type: 'object',
      properties: {
        fromIso: { type: 'string', description: 'ISO 8601 start of the window, inclusive. Default: now.' },
        toIso: { type: 'string', description: 'ISO 8601 end of the window, exclusive. Default: 14 days after fromIso.' },
        patientName: { type: 'string', description: 'Limit to one patient.' },
        includeCancelled: { type: 'boolean', description: 'Include cancelled visits (default false).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_appointment',
    description:
      'Cancel a booked visit. The visit is KEPT and marked cancelled: the calendar shows it struck through and the patient’s record shows the cancellation, so this is safe and reversible from the calendar. Identify it by the handle from list_appointments. Confirm with the user before you call this.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Handle from list_appointments, e.g. APT-4F2A' },
        patientName: { type: 'string', description: 'Use only when the patient has exactly one upcoming visit' },
        reason: { type: 'string', description: 'Why, in the caller’s own words. Leave it out if they did not say.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reschedule_appointment',
    description:
      'Move an existing visit to a new date and time. Same visit, new slot — the calendar and the patient record both show the move. Identify it by the handle from list_appointments.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Handle from list_appointments, e.g. APT-4F2A' },
        patientName: { type: 'string', description: 'Use only when the patient has exactly one upcoming visit' },
        startIso: { type: 'string', description: 'New ISO 8601 start with offset' },
        minutes: { type: 'integer', description: 'New visit length in minutes' },
      },
      required: ['startIso'],
      additionalProperties: false,
    },
  },
  {
    name: 'order_scan',
    description:
      'Place a NEW imaging order (MRI, CT, X-ray…) for a registered patient and immediately compile + submit its prior-auth packet through the full pipeline. Use this when the user wants to order a scan for a specific patient — run_agent prior-auth only re-fires the seeded demo order.',
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        procedure: { type: 'string', description: 'e.g. "CT abdomen with contrast" (default: MRI lumbar spine)' },
        reason: { type: 'string', description: 'Clinical indication in the clinician’s words, e.g. "chronic back pain, failed 6 weeks PT"' },
      },
      required: ['patientName'],
      additionalProperties: false,
    },
  },
  {
    name: 'complete_visit',
    description:
      'Front desk checkout: end the patient’s visit. Marks their appointment fulfilled, records the finished encounter (which fires the discharge agent: post-visit outreach + follow-up booking through the full pipeline), and drafts the visit claim. Returns the claim identifier — always tell the user and reuse it for later run_agent calls on their claim.',
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        procedure: { type: 'string', description: 'What the visit was, e.g. "Office visit — annual physical"' },
        amount: { type: 'number', description: 'Billed amount in USD (default 180)' },
      },
      required: ['patientName'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pending_approvals',
    description:
      'Drafts waiting for human sign-off (appeal letters the agent paused before sending). Call for "what needs my review", "pending approvals", "anything waiting on me".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'approve_draft',
    description:
      'Approve and SEND the appeal draft awaiting review — this is the clinic approving its own outgoing letter, NOT the payer approving a claim (that is run_agent with event approve). Optional runId (defaults to the newest pending draft). Optional editedLetter to send a revised letter — keep the [NAME_1]-style tokens exactly as shown in the draft.',
    input_schema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id of the pending draft (prefix ok); omit for the newest' },
        editedLetter: { type: 'string', description: 'Full revised letter text with redaction tokens preserved' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reject_draft',
    description: 'Discard the pending appeal draft without sending anything to the payer. Optional runId and reason.',
    input_schema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id of the pending draft (prefix ok); omit for the newest' },
        reason: { type: 'string', description: 'Why, in the reviewer’s words' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_agent',
    description:
      'Fire a real pipeline event. "deny" simulates a payer denial (wakes the appeal agent), "approve" records the payer approving a claim after appeal (marks the appeal WON and updates the learned playbook), "triage" runs pre-submission gap check on a claim, "discharge" runs post-discharge patient outreach + care-gap closure, "prior-auth" compiles an authorization packet for the pending MRI order.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', enum: ['deny', 'approve', 'triage', 'discharge', 'prior-auth'] },
        claimIdentifier: {
          type: 'string',
          description: 'Claim identifier, e.g. DEMO-CLAIM-1 (default) or DEMO-CLAIM-2',
        },
        denialCode: {
          type: 'string',
          enum: Object.keys(DENIAL_TEXTS),
          description: 'Denial reason for the "deny" event (default CO-197 = no prior auth)',
        },
      },
      required: ['event'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_patient_chart',
    description:
      "Open one patient's chart: age and sex, insurance, latest vital signs with BMI, their visits, the chart overview, documents on file, and recent journey events. Identifiers come back masked to their last four characters — read them back that way and never guess the rest. Call this before answering a question about a specific patient, and before editing anything on their chart.",
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string', description: 'Full or partial name' },
        patientId: { type: 'string', description: 'FHIR id from an earlier tool result — preferred when you have it' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_patient',
    description:
      "Correct or fill in a patient's demographics. Only the fields you pass are changed. Use this when someone tells you a detail is wrong or missing — never to 'tidy up' something nobody asked about.",
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        patientId: { type: 'string' },
        name: { type: 'string', description: 'Corrected full name' },
        sex: { type: 'string', enum: ['male', 'female', 'other', 'unknown'] },
        birthDate: { type: 'string', description: 'YYYY-MM-DD' },
        phone: { type: 'string' },
        email: { type: 'string' },
        addressLine: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_coverage',
    description:
      "Change a patient's insurance. Creates coverage if they have none. Changing the payer re-runs the 270/271 eligibility check and the result comes back in the summary.",
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        patientId: { type: 'string' },
        payer: { type: 'string', description: 'Insurance company, e.g. Aetna' },
        memberId: { type: 'string' },
        groupNumber: { type: 'string' },
        status: { type: 'string', enum: ['active', 'cancelled'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'record_vitals',
    description:
      'Record vital signs. Pass US customary when someone speaks in feet and pounds (heightIn, weightLb) or metric when they use centimetres and kilograms. BMI is computed from height and weight — never pass one. Systolic and diastolic must be given together.',
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        patientId: { type: 'string' },
        heightIn: { type: 'number', description: 'Height in inches' },
        heightCm: { type: 'number' },
        weightLb: { type: 'number', description: 'Weight in pounds' },
        weightKg: { type: 'number' },
        systolic: { type: 'number' },
        diastolic: { type: 'number' },
        heartRate: { type: 'number', description: 'Beats per minute' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_clinical_note',
    description:
      "Write a note onto the patient's chart. It appears on their journey immediately. Use for what someone tells you about a patient that belongs on the record.",
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        patientId: { type: 'string' },
        note: { type: 'string', description: 'The note text' },
        category: { type: 'string', enum: ['clinical note', 'front-desk note', 'phone note'] },
      },
      required: ['note'],
      additionalProperties: false,
    },
  },
  {
    name: 'regenerate_overview',
    description:
      "Rewrite the AI overview at the top of a patient's chart from their current record. Use when the chart says the overview may be out of date, or after you change something significant.",
    input_schema: {
      type: 'object',
      properties: {
        patientName: { type: 'string' },
        patientId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_pubmed',
    description:
      'Search PubMed for clinical evidence and get back real PMIDs with titles and abstracts. Call this BEFORE answering any clinical question — symptoms, causes, treatment, dosing, screening intervals, what a guideline says — so the answer carries citations the clinician can open. Search the way a clinician would: the condition plus the aspect asked about, e.g. "rheumatoid arthritis treatment DMARD" or "type 2 diabetes screening interval".',
    input_schema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'PubMed query — condition plus the aspect in question' },
        max: { type: 'integer', description: 'How many articles to return (default 3, max 6)' },
      },
      required: ['term'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_criteria',
    description:
      "Search Moss for this clinic's payer criteria and learned denial playbooks, returning MOSS ids. Call this for coverage questions — what a payer requires, whether something needs prior authorization, what has beaten a denial code before. Moss indexes payer policy and appeal history, not medical literature; use search_pubmed for clinical questions.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, e.g. "MRI lumbar spine prior authorization"' },
        max: { type: 'integer', description: 'How many passages to return (default 3, max 6)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

const EVENT_LABELS: Record<CopilotEvent, string> = {
  deny: 'simulate payer denial → appeal agent',
  approve: 'record payer approval → playbook learns',
  triage: 'claim triage',
  discharge: 'discharge outreach + care gaps',
  'prior-auth': 'prior-auth packet',
};

// Tools that report their own inner steps, so the panel can render the trace
// (and the Sources button can read the ids they retrieved).
const STREAMS_TRACE = new Set([
  'run_agent',
  'complete_visit',
  'order_scan',
  'approve_draft',
  'search_pubmed',
  'search_criteria',
]);

/** Keep a model-supplied result count sane; PubMed is rate-limited and the panel is narrow. */
function clampResults(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(6, Math.max(1, Math.round(raw))) : 3;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  onPipelineStep?: (event: PipelineStepEvent) => void,
): Promise<{ result: string; refresh: boolean; detail: string }> {
  switch (name) {
    case 'get_status': {
      const snap = await statusSnapshot();
      return { result: JSON.stringify(snap), refresh: false, detail: `${snap.pipelineRuns} runs · win rate ${snap.appeals.winRatePct ?? '—'}%` };
    }
    case 'list_runs': {
      const runs = await recentRuns(typeof input.limit === 'number' ? input.limit : 10);
      return { result: JSON.stringify(runs), refresh: false, detail: `${runs.length} run(s)` };
    }
    case 'get_artifact': {
      const artifact = await latestArtifact(typeof input.runId === 'string' ? input.runId : undefined);
      return {
        result: artifact ? JSON.stringify(artifact) : 'No artifact found yet — run an agent first.',
        refresh: false,
        detail: artifact ? `${artifact.agent}${artifact.denialCode ? ` · ${artifact.denialCode}` : ''}` : 'none found',
      };
    }
    case 'search_pubmed': {
      const term = String(input.term);
      const evidence = await searchPubMed(term as unknown as Redacted, clampResults(input.max));
      // Same shape the pipeline's retrieve step emits, so the panel's trace and
      // the Sources button pick these up with no special-casing.
      onPipelineStep?.({
        step: 'retrieve',
        detail: `${evidence.length} article(s) for "${term}"`,
        data: {
          sources: evidence.map((e) => ({
            id: `PMID:${e.pmid}`,
            kind: 'pubmed',
            title: e.title,
            snippet: e.abstract?.slice(0, 220) ?? e.citation,
          })),
        },
      });
      return {
        result: evidence.length
          ? JSON.stringify(evidence.map((e) => ({ id: `PMID:${e.pmid}`, title: e.title, citation: e.citation, abstract: e.abstract })))
          : `PubMed returned nothing for "${term}". Answer from your own knowledge and say the search came back empty.`,
        refresh: false,
        detail: evidence.length ? evidence.map((e) => `PMID:${e.pmid}`).join(', ') : 'no results',
      };
    }
    case 'search_criteria': {
      const query = String(input.query);
      const max = clampResults(input.max);
      const [criteria, playbooks] = await Promise.all([
        mossSearch(CRITERIA_INDEX, query as unknown as Redacted, max),
        mossSearch(PLAYBOOK_INDEX, query as unknown as Redacted, max),
      ]);
      const hits = [...criteria, ...playbooks].slice(0, max);
      onPipelineStep?.({
        step: 'retrieve',
        detail: `${hits.length} passage(s) for "${query}"`,
        data: {
          sources: hits.map((h) => ({
            id: `MOSS:${h.id}`,
            kind: 'moss',
            title: h.metadata?.kind ? `${h.metadata.kind}: ${h.id}` : h.id,
            snippet: h.text.slice(0, 220),
          })),
        },
      });
      return {
        result: hits.length
          ? JSON.stringify(hits.map((h) => ({ id: `MOSS:${h.id}`, text: h.text.slice(0, 1200) })))
          : `Moss has nothing indexed for "${query}". Say so rather than guessing at what the payer requires.`,
        refresh: false,
        detail: hits.length ? hits.map((h) => `MOSS:${h.id}`).join(', ') : 'no results',
      };
    }
    case 'register_patient': {
      const r = await registerPatient({
        name: String(input.name),
        birthDate: typeof input.birthDate === 'string' ? input.birthDate : undefined,
        phone: typeof input.phone === 'string' ? input.phone : undefined,
        payer: String(input.payer),
        memberId: typeof input.memberId === 'string' ? input.memberId : undefined,
      });
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'check_coverage': {
      const r = await checkCoverage(String(input.patientName));
      return { result: r.summary, refresh: false, detail: r.summary };
    }
    case 'book_appointment': {
      const r = await bookAppointment({
        patientName: String(input.patientName),
        description: typeof input.description === 'string' ? input.description : undefined,
        startIso: typeof input.startIso === 'string' ? input.startIso : undefined,
        minutes: typeof input.minutes === 'number' ? input.minutes : undefined,
        source: 'copilot',
      });
      return { result: [r.summary, r.warning].filter(Boolean).join(' '), refresh: true, detail: r.summary };
    }
    case 'list_appointments': {
      const rows = await listCalendar({
        fromIso: typeof input.fromIso === 'string' ? input.fromIso : undefined,
        toIso: typeof input.toIso === 'string' ? input.toIso : undefined,
        patientName: typeof input.patientName === 'string' ? input.patientName : undefined,
        includeCancelled: input.includeCancelled === true,
      });
      // Full names, because the copilot serves the clinician who already holds
      // these charts — and because matching "Jane Doe" against a "Jane D."
      // projection silently reported her as having no appointments at all.
      const agentRows = rows.map((r) => ({
        handle: r.handle,
        patient: r.patientName,
        what: r.description,
        start: r.start,
        end: r.end,
        status: r.status,
        bookedBy: r.bookedBy,
      }));
      return { result: JSON.stringify(agentRows), refresh: false, detail: `${rows.length} appointment(s)` };
    }
    case 'cancel_appointment': {
      const r = await cancelAppointment({
        handle: typeof input.handle === 'string' ? input.handle : undefined,
        patientName: typeof input.patientName === 'string' ? input.patientName : undefined,
        reason: typeof input.reason === 'string' ? input.reason : undefined,
        by: 'copilot',
      });
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'reschedule_appointment': {
      const r = await rescheduleAppointment({
        handle: typeof input.handle === 'string' ? input.handle : undefined,
        patientName: typeof input.patientName === 'string' ? input.patientName : undefined,
        startIso: String(input.startIso),
        minutes: typeof input.minutes === 'number' ? input.minutes : undefined,
        by: 'copilot',
      });
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'order_scan': {
      const r = await orderScan(
        {
          patientName: String(input.patientName),
          procedure: typeof input.procedure === 'string' ? input.procedure : undefined,
          reason: typeof input.reason === 'string' ? input.reason : undefined,
        },
        onPipelineStep,
      );
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'complete_visit': {
      const r = await completeVisit(
        {
          patientName: String(input.patientName),
          procedure: typeof input.procedure === 'string' ? input.procedure : undefined,
          amount: typeof input.amount === 'number' ? input.amount : undefined,
        },
        onPipelineStep,
      );
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'run_agent': {
      const event = input.event as CopilotEvent;
      const fired = await fireEvent(
        event,
        {
          claimIdentifier: typeof input.claimIdentifier === 'string' ? input.claimIdentifier : undefined,
          denialCode: typeof input.denialCode === 'string' ? input.denialCode : undefined,
        },
        onPipelineStep,
      );
      return { result: fired.summary, refresh: true, detail: fired.summary };
    }
    case 'list_pending_approvals': {
      const drafts = listPending();
      return {
        result: drafts.length ? JSON.stringify(drafts) : 'Nothing is awaiting approval.',
        refresh: false,
        detail: `${drafts.length} draft(s) awaiting approval`,
      };
    }
    case 'approve_draft': {
      const r = await approveDraft(
        {
          runId: typeof input.runId === 'string' ? input.runId : undefined,
          editedLetter: typeof input.editedLetter === 'string' ? input.editedLetter : undefined,
        },
        onPipelineStep,
      );
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'reject_draft': {
      const r = await rejectDraft({
        runId: typeof input.runId === 'string' ? input.runId : undefined,
        reason: typeof input.reason === 'string' ? input.reason : undefined,
      });
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'get_patient_chart': {
      const store = await getStore();
      const patient = await requirePatient(store, {
        patientId: typeof input.patientId === 'string' ? input.patientId : undefined,
        patientName: typeof input.patientName === 'string' ? input.patientName : undefined,
      });
      const chart = await chartForAgent(patient.id!, store);
      if (!chart) throw new Error('That chart could not be read.');
      return {
        result: JSON.stringify(chart),
        refresh: false,
        detail: `${chart.patient} · MRN ${chart.mrn ?? '—'}`,
      };
    }
    case 'update_patient': {
      const r = await updateDemographics({
        patientId: typeof input.patientId === 'string' ? input.patientId : undefined,
        patientName: typeof input.patientName === 'string' ? input.patientName : undefined,
        name: typeof input.name === 'string' ? input.name : undefined,
        sex: typeof input.sex === 'string' ? input.sex : undefined,
        birthDate: typeof input.birthDate === 'string' ? input.birthDate : undefined,
        phone: typeof input.phone === 'string' ? input.phone : undefined,
        email: typeof input.email === 'string' ? input.email : undefined,
        addressLine: typeof input.addressLine === 'string' ? input.addressLine : undefined,
        city: typeof input.city === 'string' ? input.city : undefined,
        state: typeof input.state === 'string' ? input.state : undefined,
        postalCode: typeof input.postalCode === 'string' ? input.postalCode : undefined,
      });
      // Field names, not values: the model just sent those values, and echoing
      // them only keeps PHI in the transcript longer.
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'update_coverage': {
      const r = await updateCoverage({
        patientId: typeof input.patientId === 'string' ? input.patientId : undefined,
        patientName: typeof input.patientName === 'string' ? input.patientName : undefined,
        payer: typeof input.payer === 'string' ? input.payer : undefined,
        memberId: typeof input.memberId === 'string' ? input.memberId : undefined,
        groupNumber: typeof input.groupNumber === 'string' ? input.groupNumber : undefined,
        status: typeof input.status === 'string' ? input.status : undefined,
      });
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'record_vitals': {
      const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
      // Vitals come back in full: they are clinical facts, not identifiers, and
      // the user needs to hear them confirmed.
      const r = await recordVitals({
        patientId: typeof input.patientId === 'string' ? input.patientId : undefined,
        patientName: typeof input.patientName === 'string' ? input.patientName : undefined,
        vitals: {
          heightIn: num(input.heightIn),
          heightCm: num(input.heightCm),
          weightLb: num(input.weightLb),
          weightKg: num(input.weightKg),
          systolic: num(input.systolic),
          diastolic: num(input.diastolic),
          heartRate: num(input.heartRate),
        },
      });
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'add_clinical_note': {
      const r = await addClinicalNote({
        patientId: typeof input.patientId === 'string' ? input.patientId : undefined,
        patientName: typeof input.patientName === 'string' ? input.patientName : undefined,
        note: String(input.note),
        category: typeof input.category === 'string' ? input.category : undefined,
      });
      return { result: r.summary, refresh: true, detail: r.summary };
    }
    case 'regenerate_overview': {
      const store = await getStore();
      const patient = await requirePatient(store, {
        patientId: typeof input.patientId === 'string' ? input.patientId : undefined,
        patientName: typeof input.patientName === 'string' ? input.patientName : undefined,
      });
      const overview = await regeneratePatientOverview(patient.id!, store);
      if (!overview) throw new Error('That overview could not be rewritten.');
      return {
        result: JSON.stringify({ text: overview.text, engine: overview.engine }),
        refresh: true,
        detail: `overview rewritten (${overview.engine})`,
      };
    }
    default:
      return { result: `Unknown tool ${name}`, refresh: false, detail: 'unknown tool' };
  }
}

// ── Attached document: redaction pass, before anything else ─────────────────

/**
 * Runs the vision pass and streams it as a step the user can watch. Returns
 * the note to append to their turn — empty when the read failed, so the agent
 * loop proceeds knowing nothing rather than guessing at the card.
 */
/**
 * Who this document belongs to: the chart the user has open, else whoever the
 * name on it matches. Unresolved is a normal outcome — nothing is filed and the
 * model is told to ask.
 */
async function resolveFilingTarget(
  openChartId: string | undefined,
  name: string | undefined,
): Promise<{ patientId: string; patientName: string } | null> {
  try {
    const store = await getStore();
    const patient = openChartId
      ? await store.read<Patient>('Patient', openChartId)
      : name
        ? await findPatientByName(store, name)
        : undefined;
    return patient?.id ? { patientId: patient.id, patientName: patientDisplayName(patient) } : null;
  } catch (err) {
    console.warn('[chat] could not resolve a chart for the attachment:', err);
    return null;
  }
}

async function readAttachment(
  client: Anthropic | null,
  model: string,
  image: AttachedImage,
  emit: Emit,
  openChartId?: string,
): Promise<string> {
  const step = { type: 'tool', id: 'doc', name: 'read_document', summary: 'redact attached document' };
  emit({ ...step, status: 'running' });

  if (!client) {
    emit({ ...step, status: 'error', detail: 'reading documents needs an LLM key' });
    return '';
  }
  try {
    const reading = await readPatientDocument(client, model, image);
    // The browser holds the only redacted render, so it does the filing; this
    // just tells it which chart the copy belongs on.
    const filing = await resolveFilingTarget(openChartId, reading.fields.name);
    emit({
      type: 'pipeline',
      toolId: 'doc',
      step: 'redact-document',
      detail: `${reading.boxes.length} identifying region(s) covered`,
      data: {
        boxes: reading.boxes,
        documentType: reading.documentType,
        fields: describeForPanel(reading.fields),
        filing,
      },
    });
    emit({ ...step, status: 'done', detail: `${reading.documentType} · ${reading.boxes.length} region(s) boxed` });
    const filedNote = filing
      ? ` Filed to ${filing.patientName}'s chart.`
      : ' Not filed to any chart — no patient matched, so ask who it is for.';
    return `${describeForAgent(reading)}${filedNote}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[chat] document redaction pass failed:', err);
    emit({ ...step, status: 'error', detail: `could not read the image — ${message}` });
    return '';
  }
}

// ── LLM-driven agent loop ───────────────────────────────────────────────────

async function agentLoop(client: Anthropic, history: ChatMessage[], model: string, emit: Emit): Promise<void> {
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  let stepId = 0;

  for (let turn = 0; turn < 6; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system: copilotSystemPrompt(),
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      emit({ type: 'text', text: 'I can’t help with that request.' });
      return;
    }

    const narrating = response.stop_reason === 'tool_use';
    for (const block of response.content) {
      // Text alongside a tool call is the model narrating what it is about to
      // do; the panel shows that as a thinking step, not as the answer. Only
      // the last turn's text is the answer, and only that gets spoken.
      if (block.type === 'text' && block.text.trim()) {
        emit({ type: narrating ? 'thought' : 'text', text: block.text });
      }
    }

    if (response.stop_reason !== 'tool_use') return;

    messages.push({ role: 'assistant', content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const id = `s${++stepId}`;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const summary =
        block.name === 'run_agent'
          ? EVENT_LABELS[input.event as CopilotEvent] ?? String(input.event)
          : block.name.replace(/_/g, ' ');
      emit({ type: 'tool', id, name: block.name, summary, status: 'running' });
      try {
        const onPipelineStep =
          STREAMS_TRACE.has(block.name)
            ? (pe: PipelineStepEvent) => emit({ type: 'pipeline', toolId: id, step: pe.step, detail: pe.detail, data: pe.data })
            : undefined;
        const { result, refresh, detail } = await executeTool(block.name, input, onPipelineStep);
        emit({ type: 'tool', id, name: block.name, summary, status: 'done', detail, refresh });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'tool', id, name: block.name, summary, status: 'error', detail: message });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }
  emit({ type: 'text', text: 'Stopping here — that took more steps than expected. Ask me to continue if needed.' });
}

// ── Patient persona (in-phone copilot on /patient) ──────────────────────────

/** Feed lines + first name for the patient persona, from the same portal data the phone renders. */
async function patientContext(patientId?: string): Promise<{ firstName: string; feedLines: string[] }> {
  const { patient, items } = await patientPortal(patientId);
  return {
    firstName: patient?.name.split(' ')[0] ?? 'there',
    feedLines: items.map((i) => `- [${new Date(i.at).toDateString()}] ${i.title}${i.body ? ` — ${i.body}` : ''}`),
  };
}

/** The only staff tools the patient persona may use — self-service registration and booking. */
const PATIENT_TOOLS = TOOLS.filter(
  (t) => t.name === 'register_patient' || t.name === 'book_appointment' || t.name === 'check_coverage',
);

/** Chat loop for the patient: answers from their own feed; can register themselves and book visits. */
async function patientLoop(
  client: Anthropic,
  history: ChatMessage[],
  model: string,
  emit: Emit,
  patientId?: string,
): Promise<void> {
  const { firstName, feedLines } = await patientContext(patientId);
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  let stepId = 0;

  for (let turn = 0; turn < 4; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 1200,
      output_config: { effort: 'low' },
      system: patientCopilotSystemPrompt(firstName, feedLines),
      tools: PATIENT_TOOLS,
      messages,
    });
    if (response.stop_reason === 'refusal') {
      emit({ type: 'text', text: 'I can’t help with that — please call the clinic and they’ll sort you out.' });
      return;
    }
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) emit({ type: 'text', text: block.text });
    }
    if (response.stop_reason !== 'tool_use') return;

    messages.push({ role: 'assistant', content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const id = `p${++stepId}`;
      const summary =
        block.name === 'register_patient'
          ? 'signing you up'
          : block.name === 'check_coverage'
            ? 'checking your insurance'
            : 'booking your visit';
      emit({ type: 'tool', id, name: block.name, summary, status: 'running' });
      try {
        const { result, refresh, detail } = await executeTool(block.name, (block.input ?? {}) as Record<string, unknown>);
        emit({ type: 'tool', id, name: block.name, summary, status: 'done', detail, refresh });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'tool', id, name: block.name, summary, status: 'error', detail: message });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }
}

/** No-LLM fallback for the patient persona: read the feed back in plain words. */
async function patientFallback(emit: Emit, patientId?: string): Promise<void> {
  const { firstName, feedLines } = await patientContext(patientId);
  emit({
    type: 'text',
    text:
      feedLines.length > 0
        ? `Hi ${firstName}! Here’s the latest on your care: ${feedLines.slice(0, 3).map((l) => l.replace(/^- \[[^\]]*\] /, '')).join(' · ')}. Anything else, just call the clinic.`
        : `Hi ${firstName}! Nothing new on your care feed yet. If you have questions, the clinic is a call away.`,
  });
}

// ── Keyword fallback (no API key) ───────────────────────────────────────────

function fmtDur(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 90_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Good-enough date parsing for the no-LLM fallback only — presentation logic,
 * not domain logic, so it stays beside the router rather than in lib/.
 * Returns undefined when nothing date-like is present.
 */
function parseLooseDate(text: string): string | undefined {
  const [year, month, day] = todayKey(CLINIC_TIME_ZONE).split('-').map(Number);
  let target: Date | undefined;

  if (/\btoday\b/.test(text)) target = new Date(Date.UTC(year, month - 1, day));
  else if (/\btomorrow\b/.test(text)) target = new Date(Date.UTC(year, month - 1, day + 1));
  else {
    const named = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(text));
    if (named >= 0) {
      const base = new Date(Date.UTC(year, month - 1, day));
      const delta = (named - base.getUTCDay() + 7) % 7 || 7;
      target = new Date(Date.UTC(year, month - 1, day + delta));
    }
  }
  if (!target) return undefined;

  const at = /\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text);
  let minutes = 10 * 60;
  if (at) {
    let hour = Number(at[1]) % 12;
    if (at[3] === 'pm') hour += 12;
    minutes = hour * 60 + Number(at[2] ?? 0);
  }
  return zonedIso(target.toISOString().slice(0, 10), minutes, CLINIC_TIME_ZONE);
}

async function fallbackChat(history: ChatMessage[], emit: Emit): Promise<void> {
  const text = history[history.length - 1]?.content.toLowerCase() ?? '';
  const claim = /claim[\s-]*2|demo-claim-2/.test(text) ? 'DEMO-CLAIM-2' : 'DEMO-CLAIM-1';
  const code = Object.keys(DENIAL_TEXTS).find((c) => text.includes(c.toLowerCase()));

  const runTool = async (event: CopilotEvent, summary: string) => {
    emit({ type: 'tool', id: 'f1', name: 'run_agent', summary, status: 'running' });
    try {
      const fired = await fireEvent(event, { claimIdentifier: claim, denialCode: code }, (pe) =>
        emit({ type: 'pipeline', toolId: 'f1', step: pe.step, detail: pe.detail, data: pe.data }),
      );
      emit({ type: 'tool', id: 'f1', name: 'run_agent', summary, status: 'done', detail: fired.summary, refresh: true });
      emit({ type: 'text', text: `Done. ${fired.summary}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'tool', id: 'f1', name: 'run_agent', summary, status: 'error', detail: message });
      emit({ type: 'text', text: `That didn't work: ${message}` });
    }
  };

  // Calendar work must be tested BEFORE the agent events: "book a follow-up for
  // Maria" contains "follow-up" and would otherwise fire the whole discharge pipeline.
  const isCalendar =
    /\b(book|schedule|cancel|call off|move|reschedule|calendar|what'?s on|who'?s (coming|booked)|appointments?)\b/.test(
      text,
    );

  if (isCalendar) {
    const calendarStep = async (name: string, summary: string, run: () => Promise<string>) => {
      emit({ type: 'tool', id: 'f1', name, summary, status: 'running' });
      try {
        const detail = await run();
        emit({ type: 'tool', id: 'f1', name, summary, status: 'done', detail, refresh: name !== 'list_appointments' });
        emit({ type: 'text', text: detail });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'tool', id: 'f1', name, summary, status: 'error', detail: message });
        emit({ type: 'text', text: message });
      }
    };

    const handle = text.match(/\bapt-[0-9a-f]{4}\b/i)?.[0];
    const named = text.match(/\bfor\s+([a-z][a-z' -]{1,40}?)(?:\s+(?:on|at|tomorrow|today|next)\b|[.,?]|$)/i)?.[1];

    if (/\b(cancel|call off)\b/.test(text)) {
      return calendarStep('cancel_appointment', 'cancel a visit', async () => {
        const r = await cancelAppointment({ handle, patientName: handle ? undefined : named, by: 'copilot' });
        return r.summary;
      });
    }
    if (/\b(move|reschedule)\b/.test(text)) {
      return calendarStep('reschedule_appointment', 'move a visit', async () => {
        const when = parseLooseDate(text);
        if (!when) return 'Tell me the new date and time — for example "move APT-4F2A to Thursday at 2pm".';
        const r = await rescheduleAppointment({
          handle,
          patientName: handle ? undefined : named,
          startIso: when,
          by: 'copilot',
        });
        return r.summary;
      });
    }
    if (/\b(book|schedule)\b/.test(text) && named) {
      return calendarStep('book_appointment', 'book a visit', async () => {
        const r = await bookAppointment({ patientName: named, startIso: parseLooseDate(text), source: 'copilot' });
        return [r.summary, r.warning].filter(Boolean).join(' ');
      });
    }
    return calendarStep('list_appointments', 'read the calendar', async () => {
      const rows = await listCalendar({ patientName: named });
      if (rows.length === 0) return 'Nothing booked in that range.';
      const lines = rows
        .slice(0, 6)
        .map((r) => `${r.handle} ${formatSlot(r.start, r.end)}, ${r.patientShortName}, ${r.description}`)
        .join('; ');
      return `${rows.length} visit(s) coming up: ${lines}. Say "cancel APT-XXXX" to call one off.`;
    });
  }

  // A pending draft owns the approve/reject verbs; with nothing pending, the
  // old semantics below (approve = payer approval) are untouched.
  const drafts = listPending();
  if (drafts.length > 0 && /(reject|discard|scrap|don'?t send|hold off)/.test(text)) {
    emit({ type: 'tool', id: 'f1', name: 'reject_draft', summary: 'reject the draft', status: 'running' });
    const r = await rejectDraft({});
    emit({ type: 'tool', id: 'f1', name: 'reject_draft', summary: 'reject the draft', status: 'done', detail: r.summary, refresh: true });
    emit({ type: 'text', text: r.summary });
    return;
  }
  if (drafts.length > 0 && /(approve|send it|looks good|ship it|go ahead|sign off)/.test(text)) {
    emit({ type: 'tool', id: 'f1', name: 'approve_draft', summary: 'approve & send the draft', status: 'running' });
    const r = await approveDraft({}, (pe) =>
      emit({ type: 'pipeline', toolId: 'f1', step: pe.step, detail: pe.detail, data: pe.data }),
    );
    emit({ type: 'tool', id: 'f1', name: 'approve_draft', summary: 'approve & send the draft', status: 'done', detail: r.summary, refresh: true });
    emit({ type: 'text', text: r.summary });
    return;
  }
  if (/(needs (my )?review|pending approval|awaiting approval|review queue|waiting on me)/.test(text)) {
    emit({ type: 'tool', id: 'f1', name: 'list_pending_approvals', summary: 'check the review queue', status: 'running' });
    emit({ type: 'tool', id: 'f1', name: 'list_pending_approvals', summary: 'check the review queue', status: 'done', detail: `${drafts.length} draft(s)` });
    emit({
      type: 'text',
      text: drafts.length
        ? `${drafts.length} draft(s) awaiting your sign-off: ${drafts.map((d) => `${d.denialCode ?? 'appeal'} (run ${d.runId.slice(0, 8)})`).join(', ')}. Say "approve the appeal" or "reject the appeal".`
        : 'Nothing is waiting on you — the review queue is clear.',
    });
    return;
  }

  if (/(approve|approv|overturn|won|paid)/.test(text)) return runTool('approve', EVENT_LABELS.approve);
  if (/(deny|denial|appeal|reject)/.test(text)) return runTool('deny', EVENT_LABELS.deny);
  if (/(discharge|outreach|call the patient|follow[- ]?up|care gap)/.test(text)) return runTool('discharge', EVENT_LABELS.discharge);
  if (/(prior[- ]?auth|authorization|mri)/.test(text)) return runTool('prior-auth', EVENT_LABELS['prior-auth']);
  if (/(triage|submit|scrub|check the claim|clean claim)/.test(text)) return runTool('triage', EVENT_LABELS.triage);

  if (/(status|win rate|how are we|dashboard|summary|numbers|doing)/.test(text)) {
    emit({ type: 'tool', id: 'f1', name: 'get_status', summary: 'get status', status: 'running' });
    const snap = await statusSnapshot();
    emit({ type: 'tool', id: 'f1', name: 'get_status', summary: 'get status', status: 'done', detail: `${snap.pipelineRuns} runs` });
    const pb = snap.playbook
      .map((p) => `${p.denialCode}: ${p.wins}W/${p.losses}L, avg turnaround ${fmtDur(p.avgTurnaroundMs)}`)
      .join('; ');
    emit({
      type: 'text',
      text:
        `Appeal win rate is ${snap.appeals.winRatePct != null ? `${snap.appeals.winRatePct}%` : 'not established yet'} ` +
        `(${snap.appeals.won} won, ${snap.appeals.lost} lost, ${snap.appeals.pending} pending). ` +
        `${snap.careGapsClosed} care gap(s) closed, ${snap.phiTokensRedacted} PHI tokens redacted across ${snap.pipelineRuns} runs. ` +
        (pb ? `Playbook — ${pb}.` : 'No playbook entries yet.'),
    });
    return;
  }

  if (/(letter|artifact|packet|show me)/.test(text)) {
    const artifact = await latestArtifact();
    emit({
      type: 'text',
      text: artifact
        ? `Latest ${artifact.agent} artifact${artifact.denialCode ? ` (${artifact.denialCode})` : ''}:\n\n${artifact.letterRedacted}`
        : 'No artifacts yet — ask me to appeal a denial or run discharge outreach first.',
    });
    return;
  }

  emit({
    type: 'text',
    text:
      'I can run the back office for you. Try: "appeal the denial on claim 1", "the payer approved claim 1", "run discharge outreach", "start the prior auth for the MRI", "triage claim 2", "what\'s our win rate?", "what\'s on the calendar", "book a check-up for Leo Kim tomorrow at 2pm", or "cancel APT-4F2A".',
  });
}

// ── Route ───────────────────────────────────────────────────────────────────

interface ChatRequest {
  messages?: ChatMessage[];
  model?: string;
  attachment?: { mediaType?: string; base64?: string };
  persona?: string;
  patientId?: string;
}

/** Validate an uploaded image at the boundary; anything malformed is dropped, not trusted. */
function parseAttachment(raw: ChatRequest['attachment']): AttachedImage | null {
  if (!raw || typeof raw.base64 !== 'string' || !raw.base64) return null;
  const mediaType = IMAGE_MEDIA_TYPES.find((type) => type === raw.mediaType);
  if (!mediaType || raw.base64.length > MAX_BASE64_LENGTH) return null;
  return { mediaType, base64: raw.base64 };
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
  }
  const history = (body.messages ?? []).filter((m) => m && typeof m.content === 'string').slice(-20);
  if (history.length === 0) return NextResponse.json({ error: 'messages required' }, { status: 400 });
  const model = resolveChatModel(typeof body.model === 'string' ? body.model : undefined);
  const attachment = parseAttachment(body.attachment);
  const isPatient = body.persona === 'patient';
  const patientId = typeof body.patientId === 'string' ? body.patientId : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit: Emit = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const client = getLlmClient();
        if (attachment) {
          const note = await readAttachment(client, model, attachment, emit, isPatient ? undefined : patientId);
          const last = history[history.length - 1];
          if (note && last) last.content = `${last.content}\n\n${note}`.trim();
        }
        if (isPatient) {
          if (client) {
            try {
              await patientLoop(client, history, model, emit, patientId);
            } catch (err) {
              console.warn('[chat] patient loop failed — falling back:', err);
              await patientFallback(emit, patientId);
            }
          } else {
            await patientFallback(emit, patientId);
          }
        } else if (client) {
          try {
            await agentLoop(client, history, model, emit);
          } catch (err) {
            console.warn('[chat] LLM loop failed — falling back to keyword router:', err);
            await fallbackChat(history, emit);
          }
        } else {
          await fallbackChat(history, emit);
        }
        emit({ type: 'done' });
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' },
  });
}
