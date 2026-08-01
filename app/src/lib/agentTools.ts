import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import type { Communication, Resource } from '@medplum/fhirtypes';
import type { CorpusDoc } from './corpus';
import { listEpisodic } from './memory/episodic';
import { type FhirStore, writeAudit } from './medplum.server';
import { CRITERIA_INDEX, mossSearch, mossUpsert, PLAYBOOK_INDEX } from './moss.server';
import { searchPubMed } from './pubmed.server';
import type { RetrievedSource } from './retrieve';
import { checkEligibility, sendAttachment275, submitClaim837, submitPriorAuth278 } from './stedi.server';

/**
 * The tool surface the four agents reason with. Generic FHIR CRUD plus every
 * connector, so an agent can look up what it needs and write what it decides
 * rather than working only from the context the pipeline pre-assembled.
 *
 * Two rules encode facts about the plumbing and go stale if it changes:
 * `fhir_search` enumerates its params because the in-memory store silently
 * returns [] for any key outside that allowlist (medplum.server.ts `matches`),
 * and the three retrieval tools register what they return so reason.ts can
 * widen the citation allowlist — an id fetched mid-run is otherwise deleted
 * from the artifact by the citation validator.
 */

export interface AgentToolResult {
  /** Payload for the tool_result block. */
  content: string;
  /** One-line summary for the run trace; never fed back to the model. */
  detail: string;
}

/** FHIR search params the in-memory store actually understands. */
const SEARCH_PARAMS = ['focus', 'subject', 'patient', 'request', 'beneficiary', 'status', 'code', 'identifier'] as const;

const MAX_RESULT_CHARS = 6000;
const MAX_SEARCH_COUNT = 25;
const DEFAULT_SEARCH_COUNT = 10;

const searchParamProperties = Object.fromEntries(
  SEARCH_PARAMS.map((p) => [
    p,
    {
      type: 'string',
      description:
        p === 'code'
          ? 'Matches code.coding[].code, e.g. "70551".'
          : p === 'status'
            ? 'Exact status value, e.g. "active".'
            : p === 'identifier'
              ? 'Matches identifier[].value, e.g. "DEMO-CLAIM-1".'
              : `Full reference string, e.g. "Patient/abc123" — matches ${p}.reference.`,
    },
  ]),
);

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'fhir_search',
    description:
      'Find FHIR resources in this clinic\'s datastore. Only the parameters listed here are supported — no dates, no free text, no _lastUpdated. Useful moves: Task with focus=<trigger reference> to see whether this event was already handled; ServiceRequest with patient=<patient reference> and status=active for open orders; Communication with patient=<patient reference> for past outreach and call transcripts; Basic with code=episodic-run for raw run memory. Returns one summary line per hit — call fhir_read for a full resource.',
    input_schema: {
      type: 'object',
      properties: {
        resourceType: { type: 'string', description: 'FHIR resource type, e.g. "Task", "Claim", "ServiceRequest".' },
        ...searchParamProperties,
        count: { type: 'integer', description: `Max results (default ${DEFAULT_SEARCH_COUNT}, cap ${MAX_SEARCH_COUNT}).` },
      },
      required: ['resourceType'],
      additionalProperties: false,
    },
  },
  {
    name: 'fhir_read',
    description: 'Read one complete FHIR resource by type and id. Use the RESOURCE HANDLES in your task message, or an id from fhir_search.',
    input_schema: {
      type: 'object',
      properties: {
        resourceType: { type: 'string', description: 'FHIR resource type, e.g. "Claim".' },
        id: { type: 'string', description: 'Resource id — the part after the slash in "Claim/abc123".' },
      },
      required: ['resourceType', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'fhir_create',
    description:
      'Create a new FHIR resource. Pass a complete resource including resourceType. Link it to the case via subject, focus, or basedOn so it is findable later. The runtime already books appointments, files the prior-auth packet DocumentReference, and writes the Task and Communication for this run — do not duplicate those.',
    input_schema: {
      type: 'object',
      properties: {
        resource: { type: 'object', description: 'The complete FHIR resource, including resourceType.' },
      },
      required: ['resource'],
      additionalProperties: false,
    },
  },
  {
    name: 'fhir_update',
    description:
      'Replace an existing FHIR resource wholesale. The resource must carry its id, and every field you omit is LOST. Prefer fhir_patch unless you are deliberately rewriting the whole resource.',
    input_schema: {
      type: 'object',
      properties: {
        resource: { type: 'object', description: 'The complete replacement resource, including resourceType and id.' },
      },
      required: ['resource'],
      additionalProperties: false,
    },
  },
  {
    name: 'fhir_patch',
    description:
      'Change specific fields on an existing resource, leaving the rest intact. There is no delete: to retract something, patch its status to "entered-in-error", "revoked", or "cancelled".',
    input_schema: {
      type: 'object',
      properties: {
        resourceType: { type: 'string', description: 'FHIR resource type.' },
        id: { type: 'string', description: 'Resource id.' },
        changes: { type: 'object', description: 'Top-level fields to set. Cannot change id or resourceType.' },
      },
      required: ['resourceType', 'id', 'changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'moss_search',
    description:
      'Search the clinic knowledge base. "payer-criteria" holds published payer coverage policy, LCD/NCD, and internal SOPs; "denial-playbooks" holds denial playbooks including LEARNED entries written from appeals that actually won. Ids returned here are citable as [MOSS:<id>].',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'string', enum: [CRITERIA_INDEX, PLAYBOOK_INDEX], description: 'Which index to search.' },
        query: { type: 'string', description: 'Search terms — payer, procedure, denial code, requirement.' },
        topK: { type: 'integer', description: 'Max hits (default 4).' },
      },
      required: ['index', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'moss_upsert',
    description:
      'Write a document into the knowledge base so future runs retrieve it. Use sparingly, for a durable lesson worth reusing — not for notes about this one case.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'string', enum: [CRITERIA_INDEX, PLAYBOOK_INDEX], description: 'Which index to write to.' },
        docs: {
          type: 'array',
          description: 'Documents to upsert.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id; re-using one overwrites that document.' },
              text: { type: 'string', description: 'Document body.' },
            },
            required: ['id', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['index', 'docs'],
      additionalProperties: false,
    },
  },
  {
    name: 'pubmed_search',
    description:
      'Search PubMed for peer-reviewed clinical evidence. PMIDs returned here are citable as [PMID:<id>]. Never cite a PMID this tool did not return.',
    input_schema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'PubMed query syntax, e.g. \'"magnetic resonance imaging" AND headache AND guideline\'.' },
        max: { type: 'integer', description: 'Max results (default 3, cap 5).' },
      },
      required: ['term'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description:
      'Search this back office\'s own past runs — what it decided on related cases and how those turned out. Ids returned here are citable as [MEMORY:<runId>]: institutional experience, not literature. Reuse an approach recorded as won; change one recorded as lost.',
    input_schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['claim-triage', 'denial-appeal', 'discharge-caregap', 'prior-auth-docs'],
          description: 'Only runs of this agent.',
        },
        claimRef: { type: 'string', description: 'Only runs on this claim reference.' },
        denialCode: { type: 'string', description: 'Only runs on this denial code, e.g. "CO-197".' },
        outcome: { type: 'string', enum: ['pending', 'won', 'lost', 'closed', 'failed'], description: 'Only runs with this outcome.' },
        limit: { type: 'integer', description: 'Max runs (default 5).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'stedi_eligibility_check',
    description:
      'Run a live eligibility check (EDI 270/271) against the payer. authOrCertIndicator "Y" means the payer itself says this service requires prior authorization — the strongest evidence available for a triage verdict.',
    input_schema: {
      type: 'object',
      properties: { payer: { type: 'string', description: 'Payer name.' } },
      required: ['payer'],
      additionalProperties: false,
    },
  },
  {
    name: 'stedi_submit_claim_837',
    description:
      'Submit or resubmit a claim over EDI 837. The runtime already submits the claim for this run after you finish — only call this for an ADDITIONAL submission you specifically intend.',
    input_schema: {
      type: 'object',
      properties: {
        claimRef: { type: 'string', description: 'Claim reference, e.g. "Claim/abc123".' },
        frequencyCode: { type: 'string', description: '"7" for a replacement claim, "8" to void.' },
        gapsFixed: { type: 'boolean', description: 'Whether gaps were corrected before submission.' },
      },
      required: ['claimRef'],
      additionalProperties: false,
    },
  },
  {
    name: 'stedi_send_attachment_275',
    description:
      'Transmit supporting documentation to the payer over EDI 275. The runtime already sends the appeal packet after you finish — only call this for an ADDITIONAL attachment.',
    input_schema: {
      type: 'object',
      properties: {
        claimRef: { type: 'string', description: 'Claim reference the attachment belongs to.' },
        contentSummary: { type: 'string', description: 'Short summary of what is being transmitted.' },
      },
      required: ['claimRef', 'contentSummary'],
      additionalProperties: false,
    },
  },
  {
    name: 'stedi_submit_prior_auth_278',
    description:
      'Transmit a prior-authorization request over EDI 278. The runtime already transmits the request for this run after you finish — only call this for an ADDITIONAL request.',
    input_schema: {
      type: 'object',
      properties: {
        srRef: { type: 'string', description: 'ServiceRequest reference for the ordered service.' },
        procedure: { type: 'string', description: 'Procedure being authorized.' },
      },
      required: ['srRef', 'procedure'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_voice_transcript',
    description:
      'Record a phone-call transcript on the patient\'s chart as a Communication, the same place the clinic phone line files its calls. Read past calls back with fhir_search on Communication.',
    input_schema: {
      type: 'object',
      properties: {
        patientRef: { type: 'string', description: 'Patient reference, e.g. "Patient/abc123".' },
        transcript: { type: 'string', description: 'The transcript text.' },
        encounterRef: { type: 'string', description: 'Encounter reference, when the call belongs to one.' },
      },
      required: ['patientRef', 'transcript'],
      additionalProperties: false,
    },
  },
];

/** Fields the search summary reads; the FHIR union does not declare them in common. */
type SummarizableResource = Resource & {
  status?: string;
  code?: { text?: string; coding?: Array<{ code?: string; display?: string }> };
  subject?: { reference?: string };
  focus?: { reference?: string };
  patient?: { reference?: string };
  description?: string;
};

/**
 * Executes agent tool calls against one run's store, recording which sources
 * became citable along the way.
 *
 * Deliberately knows nothing about Anthropic messages, loops, or step events:
 * it returns a `detail` line and reason.ts decides how to narrate it.
 */
export class AgentToolbox {
  private readonly sources = new Map<string, RetrievedSource>();

  constructor(private readonly store: FhirStore) {}

  /** Sources retrieved by tool calls this run — read AFTER the loop finishes. */
  get discoveredSources(): RetrievedSource[] {
    return [...this.sources.values()];
  }

  async execute(name: string, input: Record<string, unknown>): Promise<AgentToolResult> {
    switch (name) {
      case 'fhir_search':
        return this.fhirSearch(input);
      case 'fhir_read':
        return this.fhirRead(input);
      case 'fhir_create':
        return this.fhirCreate(input);
      case 'fhir_update':
        return this.fhirUpdate(input);
      case 'fhir_patch':
        return this.fhirPatch(input);
      case 'moss_search':
        return this.mossSearchTool(input);
      case 'moss_upsert':
        return this.mossUpsertTool(input);
      case 'pubmed_search':
        return this.pubmedSearchTool(input);
      case 'memory_search':
        return this.memorySearchTool(input);
      case 'stedi_eligibility_check':
        return this.eligibilityTool(input);
      case 'stedi_submit_claim_837':
        return this.claim837Tool(input);
      case 'stedi_send_attachment_275':
        return this.attachment275Tool(input);
      case 'stedi_submit_prior_auth_278':
        return this.priorAuth278Tool(input);
      case 'record_voice_transcript':
        return this.voiceTranscriptTool(input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ── FHIR ──────────────────────────────────────────────────────────────────

  private async fhirSearch(input: Record<string, unknown>): Promise<AgentToolResult> {
    const resourceType = this.asResourceType(input.resourceType);
    const params: Record<string, string> = {};
    for (const key of SEARCH_PARAMS) {
      const value = optionalString(input[key]);
      if (value) params[key] = value;
    }
    const count = clampCount(input.count, DEFAULT_SEARCH_COUNT, MAX_SEARCH_COUNT);
    params._count = String(count);

    const found = await this.store.search<Resource>(resourceType, params);
    const hits = found.slice(0, count);
    const filterText = Object.entries(params)
      .filter(([k]) => k !== '_count')
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');

    const lines = hits.map((r) => summarizeResource(r));
    return {
      content: truncate(
        lines.length ? lines.join('\n') : `No ${resourceType} matched${filterText ? ` ${filterText}` : ''}.`,
      ),
      detail: `${resourceType}${filterText ? ` where ${filterText}` : ''} → ${found.length} result(s)`,
    };
  }

  private async fhirRead(input: Record<string, unknown>): Promise<AgentToolResult> {
    const resourceType = this.asResourceType(input.resourceType);
    const id = requireString(input, 'id', 'fhir_read');
    const resource = await this.store.read<Resource>(resourceType, id);
    if (!resource) throw new Error(`No ${resourceType}/${id} in the datastore`);
    return { content: truncate(JSON.stringify(resource, null, 1)), detail: `read ${resourceType}/${id}` };
  }

  private async fhirCreate(input: Record<string, unknown>): Promise<AgentToolResult> {
    const resource = this.asResource(input.resource, 'fhir_create');
    const created = await this.store.create(resource);
    return {
      content: `Created ${created.resourceType}/${created.id}`,
      detail: `created ${created.resourceType}/${created.id}`,
    };
  }

  private async fhirUpdate(input: Record<string, unknown>): Promise<AgentToolResult> {
    const resource = this.asResource(input.resource, 'fhir_update');
    if (!resource.id) throw new Error('fhir_update requires the resource to carry its `id`');
    const updated = await this.store.update(resource);
    return {
      content: `Replaced ${updated.resourceType}/${updated.id}`,
      detail: `replaced ${updated.resourceType}/${updated.id}`,
    };
  }

  private async fhirPatch(input: Record<string, unknown>): Promise<AgentToolResult> {
    const resourceType = this.asResourceType(input.resourceType);
    const id = requireString(input, 'id', 'fhir_patch');
    const changes = input.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new Error('fhir_patch requires `changes` to be an object of fields to set');
    }
    const patch = changes as Record<string, unknown>;
    if ('id' in patch || 'resourceType' in patch) {
      throw new Error('fhir_patch cannot change `id` or `resourceType`');
    }
    const existing = await this.store.read<Resource>(resourceType, id);
    if (!existing) throw new Error(`No ${resourceType}/${id} to patch`);

    // Shallow top-level merge, the same idiom updateEpisodic uses: a deep merge
    // would make it impossible to clear or replace a nested array on purpose.
    const merged = { ...existing, ...patch } as Resource;
    const updated = await this.store.update(merged);
    const fields = Object.keys(patch).join(', ');
    return {
      content: `Patched ${updated.resourceType}/${updated.id} (${fields})`,
      detail: `patched ${resourceType}/${id} — ${fields}`,
    };
  }

  // ── Retrieval (registers citable sources) ─────────────────────────────────

  private async mossSearchTool(input: Record<string, unknown>): Promise<AgentToolResult> {
    const index = requireString(input, 'index', 'moss_search');
    const query = requireString(input, 'query', 'moss_search');
    const topK = clampCount(input.topK, 4, 8);
    const hits = await mossSearch(index, query, topK);
    const sources: RetrievedSource[] = hits.map((h) => ({
      id: `MOSS:${h.id}`,
      kind: 'moss',
      title: h.metadata?.kind ? `${h.metadata.kind}: ${h.id}` : h.id,
      text: h.text,
    }));
    this.register(sources);
    return {
      content: truncate(sources.map((s) => `[${s.id}] ${s.title}\n${s.text}`).join('\n\n') || 'No matching documents.'),
      detail: `${index} "${query}" → ${hits.length} hit(s)`,
    };
  }

  private async mossUpsertTool(input: Record<string, unknown>): Promise<AgentToolResult> {
    const index = requireString(input, 'index', 'moss_upsert');
    const raw = input.docs;
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('moss_upsert requires a non-empty `docs` array');
    const docs: CorpusDoc[] = raw.map((d, i) => {
      const doc = (d ?? {}) as Record<string, unknown>;
      const id = optionalString(doc.id);
      const text = optionalString(doc.text);
      if (!id || !text) throw new Error(`moss_upsert docs[${i}] needs both \`id\` and \`text\``);
      return { id, text };
    });
    await mossUpsert(index, docs);
    return {
      content: `Wrote ${docs.length} document(s) to ${index}: ${docs.map((d) => d.id).join(', ')}`,
      detail: `${index} ← ${docs.length} doc(s)`,
    };
  }

  private async pubmedSearchTool(input: Record<string, unknown>): Promise<AgentToolResult> {
    const term = requireString(input, 'term', 'pubmed_search');
    const max = clampCount(input.max, 3, 5);
    const evidence = await searchPubMed(term, max);
    const sources: RetrievedSource[] = evidence.map((e) => ({
      id: `PMID:${e.pmid}`,
      kind: 'pubmed',
      title: e.title,
      text: `${e.citation}${e.abstract ? ` — ${e.abstract}` : ''}`,
    }));
    this.register(sources);
    return {
      content: truncate(sources.map((s) => `[${s.id}] ${s.title}\n${s.text}`).join('\n\n') || 'No evidence found.'),
      detail: `PubMed "${term}" → ${evidence.length} result(s)`,
    };
  }

  private async memorySearchTool(input: Record<string, unknown>): Promise<AgentToolResult> {
    const intent = optionalString(input.intent);
    const claimRef = optionalString(input.claimRef);
    const denialCode = optionalString(input.denialCode);
    const outcome = optionalString(input.outcome);
    const limit = clampCount(input.limit, 5, 15);

    const runs = (await listEpisodic(this.store))
      .filter((r) => !intent || r.intent === intent)
      .filter((r) => !claimRef || r.claimRef === claimRef)
      .filter((r) => !denialCode || r.denialCode === denialCode)
      .filter((r) => !outcome || r.outcome === outcome)
      .slice(0, limit);

    const sources: RetrievedSource[] = runs.map((r) => ({
      id: `MEMORY:${r.runId}`,
      kind: 'memory',
      // No shortened run id anywhere in the payload: an abbreviated one gets
      // cited verbatim, and the citation validator then deletes that line.
      title: `${r.intent} — ${r.outcome} (${r.createdAt.slice(0, 10)})`,
      text: [
        `${r.decision}: ${r.rationale}`,
        r.keyArguments.length ? `arguments: ${r.keyArguments.join(' | ')}` : '',
        r.denialCode ? `denial: ${r.denialCode}` : '',
        r.actionsTaken.length ? `actions: ${r.actionsTaken.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    }));
    this.register(sources);
    return {
      content: truncate(sources.map((s) => `[${s.id}] ${s.title}\n${s.text}`).join('\n\n') || 'No past runs match.'),
      detail: `memory → ${runs.length} past run(s)`,
    };
  }

  // ── Connectors ────────────────────────────────────────────────────────────

  private async eligibilityTool(input: Record<string, unknown>): Promise<AgentToolResult> {
    const payer = requireString(input, 'payer', 'stedi_eligibility_check');
    const result = await checkEligibility(payer);
    return {
      content: JSON.stringify(result),
      detail: `271 ${payer}: authOrCert=${result.authOrCertIndicator}, plan ${result.planStatus}${result.simulated ? ' (simulated)' : ''}`,
    };
  }

  private async claim837Tool(input: Record<string, unknown>): Promise<AgentToolResult> {
    const claimRef = requireString(input, 'claimRef', 'stedi_submit_claim_837');
    const ack = await submitClaim837({
      claimRef,
      frequencyCode: optionalString(input.frequencyCode),
      gapsFixed: input.gapsFixed === true,
    });
    return { content: JSON.stringify(ack), detail: `837 ${claimRef} → ${ack.status} (control ${ack.controlNumber})` };
  }

  private async attachment275Tool(input: Record<string, unknown>): Promise<AgentToolResult> {
    const claimRef = requireString(input, 'claimRef', 'stedi_send_attachment_275');
    const contentSummary = requireString(input, 'contentSummary', 'stedi_send_attachment_275');
    const ack = await sendAttachment275({ claimRef, contentSummary });
    return { content: JSON.stringify(ack), detail: `275 ${claimRef} → ${ack.status} (control ${ack.controlNumber})` };
  }

  private async priorAuth278Tool(input: Record<string, unknown>): Promise<AgentToolResult> {
    const srRef = requireString(input, 'srRef', 'stedi_submit_prior_auth_278');
    const procedure = requireString(input, 'procedure', 'stedi_submit_prior_auth_278');
    const ack = await submitPriorAuth278({ srRef, procedure });
    return { content: JSON.stringify(ack), detail: `278 ${procedure} → ${ack.status} (control ${ack.controlNumber})` };
  }

  private async voiceTranscriptTool(input: Record<string, unknown>): Promise<AgentToolResult> {
    const patientRef = requireString(input, 'patientRef', 'record_voice_transcript');
    const transcript = requireString(input, 'transcript', 'record_voice_transcript');
    const encounterRef = optionalString(input.encounterRef);
    const communication = await this.store.create<Communication>({
      resourceType: 'Communication',
      status: 'completed',
      subject: { reference: patientRef },
      encounter: encounterRef ? { reference: encounterRef } : undefined,
      sent: new Date().toISOString(),
      category: [{ text: 'voice-transcript' }],
      payload: [{ contentString: transcript }],
    });
    await writeAudit(this.store, {
      subtype: 'voice-transcript',
      description: `Agent recorded a call transcript (${transcript.length} chars)`,
      entities: [`Communication/${communication.id}`],
    });
    return {
      content: `Recorded Communication/${communication.id}`,
      detail: `transcript filed on ${patientRef}`,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private register(sources: RetrievedSource[]): void {
    for (const source of sources) if (!this.sources.has(source.id)) this.sources.set(source.id, source);
  }

  /** `Resource['resourceType']` is a literal union, so a validated string needs the cast. */
  private asResourceType(value: unknown): Resource['resourceType'] {
    const resourceType = optionalString(value);
    if (!resourceType) throw new Error('resourceType must be a non-empty string');
    return resourceType as Resource['resourceType'];
  }

  /** A model-supplied object is not assignable to the FHIR union; check, then cast once. */
  private asResource(value: unknown, tool: string): Resource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${tool} requires \`resource\` to be a FHIR resource object`);
    }
    const candidate = value as Record<string, unknown>;
    if (!optionalString(candidate.resourceType)) {
      throw new Error(`${tool} requires \`resource.resourceType\``);
    }
    return candidate as unknown as Resource;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function requireString(input: Record<string, unknown>, key: string, tool: string): string {
  const value = optionalString(input[key]);
  if (!value) throw new Error(`${tool} requires \`${key}\` as a non-empty string`);
  return value;
}

function clampCount(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, 1), max);
}

/** Keeps one oversized search from crowding the model's context. */
function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated, ${MAX_RESULT_CHARS} of ${text.length} chars shown)`;
}

function summarizeResource(resource: Resource): string {
  const r = resource as SummarizableResource;
  const label = r.code?.text ?? r.code?.coding?.[0]?.display ?? r.code?.coding?.[0]?.code ?? r.description ?? '';
  const link = r.subject?.reference ?? r.focus?.reference ?? r.patient?.reference ?? '';
  return [
    `${r.resourceType}/${r.id}`,
    r.status ? `status=${r.status}` : '',
    label ? `"${label}"` : '',
    link ? `→ ${link}` : '',
    r.meta?.lastUpdated ? `updated ${r.meta.lastUpdated}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
