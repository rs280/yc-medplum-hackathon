import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ClaimResponse, Communication, Resource, Task } from '@medplum/fhirtypes';
import { act } from './act';
import { addPending } from './approvals.server';
import { parseIntent } from './intents';
import type { IntentConfig, IntentContext } from './intents/shared';
import { getStore, writeAudit, type FhirStore } from './medplum.server';
import { applyOutcomeFeedback, markPriorAppealLost } from './memory/feedback';
import { writeEpisodic, type EpisodicRecord } from './memory/episodic';
import { hydrateLearnedPlaybooks, registerAttempt } from './memory/playbook';
import { reason, type ReasonOutput } from './reason';
import { retrieve, type RetrievedSource } from './retrieve';

/**
 * THE shared pipeline. One code path for all four agents; branching happens
 * only in parse-intent (step 1) and act (step 4 dispatch).
 *
 *   1. parse intent      FHIR event → intent config
 *   2. retrieve          Moss (all intents) + PubMed (denial-appeal only)
 *   3. reason            tool-using agent, citation-validated JSON
 *   4. write outcome     Task + Communication + AuditEvent, dispatch via Stedi
 *   5. learn             episodic record + playbook aggregate + Moss re-index
 */

export interface PipelineResult {
  status: 'completed' | 'skipped' | 'ignored' | 'feedback' | 'failed' | 'awaiting-approval';
  runId?: string;
  intent?: string;
  detail?: string;
  taskId?: string;
}

/**
 * Live progress events emitted as the pipeline actually runs, for surfaces
 * (the copilot, the dashboard) that want to show the work happening rather
 * than just the final result. These feed internal views only — the artifact
 * and context they carry are the real thing, patient detail included.
 */
export interface PipelineStepEvent {
  step: string;
  detail: string;
  data?: Record<string, unknown>;
}

const TASK_SYSTEM = 'https://autonomous-backoffice.dev/task';

export async function runPipeline(
  resource: Resource,
  onStep?: (event: PipelineStepEvent) => void,
): Promise<PipelineResult> {
  const t0 = Date.now();
  const runId = randomUUID();
  const triggerRef = `${resource.resourceType}/${resource.id}`;
  const step = (name: string, extra = '', data?: Record<string, unknown>) => {
    console.log(`[pipeline ${runId.slice(0, 8)}] ${name} (+${Date.now() - t0}ms)${extra ? ` ${extra}` : ''}`);
    onStep?.({ step: name, detail: extra.replace(/^—\s*/, ''), data });
  };

  const store = await getStore();

  // 1 ── parse intent
  const parsed = parseIntent(resource);
  if (parsed.kind === 'ignore') {
    step('ignored', `— ${parsed.reason}`);
    return { status: 'ignored', detail: parsed.reason };
  }
  if (parsed.kind === 'feedback') {
    const result = await applyOutcomeFeedback(store, resource as ClaimResponse);
    step('feedback', `— ${result.detail}`, { matched: result.matched, detail: result.detail });
    return { status: 'feedback', detail: result.detail };
  }
  const intent = parsed.intent;
  step(`parse-intent → ${intent.name}`, `for ${triggerRef}`, { intent: intent.name, trigger: triggerRef });

  // Idempotency: never double-process an event (Task-by-focus). Cancelled
  // Tasks are rejected drafts — those may be re-fired.
  const existingTasks = await store.search<Task>('Task', { focus: triggerRef });
  if (existingTasks.some((t) => t.status !== 'cancelled' && t.code?.coding?.some((c) => c.code === intent.taskCode))) {
    step('skipped', '— Task already exists for this event');
    return { status: 'skipped', intent: intent.name, detail: 'already processed (Task-by-focus)' };
  }

  // A fresh denial on a claim with a pending appeal means that appeal lost.
  if (intent.name === 'denial-appeal') {
    await markPriorAppealLost(store, (resource as ClaimResponse).request?.reference);
  }

  try {
    const ctx = await intent.buildContext(resource, store);

    const contextText = ctx.contextTextRaw;

    // 2 ── retrieve (Moss for all; PubMed for denial-appeal only)
    await hydrateLearnedPlaybooks(store);
    const sources = await retrieve(intent, {
      criteriaQuery: ctx.queryRaw,
      playbookQuery: `${ctx.denialCode ?? ''} ${ctx.queryRaw}`.trim(),
      pubmedTerm: ctx.pubmedTermRaw,
    });
    step('retrieve', `— ${sources.length} source(s)`, {
      sources: sources.map((s) => ({ id: s.id, kind: s.kind, title: s.title, snippet: s.text.slice(0, 220) })),
    });

    // 3 ── reason: the agent works the case with tools, then writes the artifact.
    // Handles, not values, are what let it read and search on its own.
    const refs: Record<string, string> = {
      trigger: triggerRef,
      ...(ctx.patientRef ? { patient: ctx.patientRef } : {}),
      ...(ctx.claimRef ? { claim: ctx.claimRef } : {}),
      ...(ctx.overdueSrs?.length
        ? { overdueScreenings: ctx.overdueSrs.map((sr) => `ServiceRequest/${sr.id}`).join(', ') }
        : {}),
    };
    const reasoned = await reason(intent, contextText, sources, ctx.meta, { store, refs, onStep });
    step('reason', `— ${reasoned.engine}: ${reasoned.decision}`, {
      engine: reasoned.engine,
      decision: reasoned.decision,
      rationale: reasoned.rationale,
      keyArguments: reasoned.keyArguments,
      citations: reasoned.citations,
      toolCalls: reasoned.toolCalls,
      letterRedacted: reasoned.letter,
    });

    // Human-in-the-loop gate: appeal letters wait for staff sign-off before
    // anything is transmitted. The draft is held whole, patient detail included
    // — the agent reads the record through its tools, so there is no redacted
    // rendering of it to hold instead.
    if (intent.name === 'denial-appeal') {
      const task = await store.create<Task>({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        code: { coding: [{ system: TASK_SYSTEM, code: intent.taskCode }], text: intent.label },
        focus: { reference: triggerRef },
        for: ctx.patientRef ? { reference: ctx.patientRef } : undefined,
        authoredOn: new Date().toISOString(),
        description: `${intent.label}: draft awaiting human approval`,
        note: [{ text: reasoned.rationale }],
      });
      addPending({
        runId,
        t0,
        triggerRef,
        taskId: task.id!,
        intent,
        ctx,
        reasoned,
        sources,
        contextText,
        createdAt: new Date().toISOString(),
      });
      step('awaiting-approval', '— appeal draft ready for your review', {
        runId,
        denialCode: ctx.denialCode,
        letterRedacted: reasoned.letter,
        rationale: reasoned.rationale,
        keyArguments: reasoned.keyArguments,
        citations: reasoned.citations,
      });
      return {
        status: 'awaiting-approval',
        runId,
        intent: intent.name,
        taskId: task.id,
        detail: 'appeal draft awaiting human approval',
      };
    }

    // 4-5 ── act, write outcome, learn (shared with the approval resume path)
    return await finalizeRun({
      store,
      runId,
      t0,
      triggerRef,
      intent,
      ctx,
      reasoned,
      sources,
      contextText,
      step,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline ${runId.slice(0, 8)}] error:`, err);
    await writeAudit(store, {
      subtype: intent.name,
      description: `Pipeline error: ${message}`,
      outcome: '8',
      entities: [triggerRef],
    }).catch(() => undefined);
    return { status: 'failed', runId, intent: intent.name, detail: message };
  }
}

/** Everything finalizeRun needs to finish a run — captured at gate time for approval resumes. */
export interface FinalizeInput {
  store: FhirStore;
  runId: string;
  t0: number;
  triggerRef: string;
  intent: IntentConfig;
  ctx: IntentContext;
  reasoned: ReasonOutput;
  sources: RetrievedSource[];
  contextText: string;
  /** The 'requested' approval Task to complete/fail in place of creating a fresh one. */
  existingTask?: Task;
  step: (name: string, extra?: string, data?: Record<string, unknown>) => void;
}

/**
 * Steps 4-5: act → Task/Communication/audit → learn. Called inline by
 * runPipeline for autonomous intents, and by the approvals module when a human
 * approves a gated draft.
 */
export async function finalizeRun(input: FinalizeInput): Promise<PipelineResult> {
  const { store, runId, t0, triggerRef, intent, ctx, reasoned, contextText, existingTask, step } = input;

  // Complete the pending approval Task on resume; create a fresh Task otherwise.
  const writeTask = (fields: Partial<Task> & Pick<Task, 'status'>): Promise<Task> =>
    existingTask
      ? store.update<Task>({ ...existingTask, ...fields, resourceType: 'Task' })
      : store.create<Task>({
          resourceType: 'Task',
          intent: 'order',
          code: { coding: [{ system: TASK_SYSTEM, code: intent.taskCode }], text: intent.label },
          focus: { reference: triggerRef },
          for: ctx.patientRef ? { reference: ctx.patientRef } : undefined,
          authoredOn: new Date().toISOString(),
          ...fields,
        });

  const finalArtifact = reasoned.letter;

  // 4 ── act (dispatch) + write outcome
  const actions = await act(store, intent, ctx, reasoned, finalArtifact);
  step('act', `— ${actions.map((a) => a.action).join(', ') || 'no dispatch'}`, {
    actions: actions.map((a) => ({ action: a.action, detail: a.detail, simulated: a.simulated ?? false })),
  });

  const communication = await store.create<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    subject: ctx.patientRef ? { reference: ctx.patientRef } : undefined,
    sent: new Date().toISOString(),
    category: [{ text: intent.artifactLabel }],
    payload: finalArtifact ? [{ contentString: finalArtifact }] : [{ contentString: reasoned.rationale }],
  });

  const task = await writeTask({
    status: 'completed',
    lastModified: new Date().toISOString(),
    description: `${intent.label}: ${reasoned.decision}`,
    note: [
      { text: reasoned.rationale },
      { text: `Actions: ${actions.map((a) => `${a.action}${a.simulated ? ' (simulated)' : ''} — ${a.detail}`).join(' | ')}` },
      { text: `Citations: ${reasoned.citations.join(', ') || 'none'} · Agent tool calls: ${reasoned.toolCalls}` },
    ],
    output: [
      {
        type: { text: intent.artifactLabel },
        valueReference: { reference: `Communication/${communication.id}` },
      },
    ],
  });

  await writeAudit(store, {
    subtype: intent.name,
    description: `${intent.label} completed: ${reasoned.decision} (${actions.length} action(s), ${reasoned.citations.length} citation(s), ${reasoned.toolCalls} agent tool call(s))`,
    entities: [triggerRef, `Task/${task.id}`, `Communication/${communication.id}`],
  });

  // 5 ── learn
  const gapsClosed = actions.filter((a) => a.action === 'care-gap-closed').length;
  const record: EpisodicRecord = {
    runId,
    intent: intent.name,
    triggerRef,
    claimRef: ctx.claimRef,
    denialCode: ctx.denialCode,
    denialLabel: ctx.denialLabel,
    inputSummary: contextText.slice(0, 400),
    retrievedSourceIds: reasoned.sources.map((s) => s.id),
    decision: reasoned.decision,
    rationale: reasoned.rationale,
    letterRedacted: reasoned.letter || undefined,
    keyArguments: reasoned.keyArguments,
    pmids: reasoned.citations.filter((c) => c.startsWith('PMID:')).map((c) => c.slice(5)),
    actionsTaken: actions.map((a) => a.action),
    gapsClosed: gapsClosed || undefined,
    engine: reasoned.engine,
    outcome: intent.name === 'denial-appeal' ? 'pending' : 'closed',
    redactionCount: 0,
    latencyMs: Date.now() - t0,
    createdAt: new Date().toISOString(),
  };
  await writeEpisodic(store, record);
  if (intent.name === 'denial-appeal' && ctx.denialCode) {
    await registerAttempt(store, ctx.denialCode, ctx.denialLabel ?? ctx.denialCode);
  }
  step('learn', `— episodic written, outcome=${record.outcome}`, {
    outcome: record.outcome,
    gapsClosed: record.gapsClosed ?? 0,
  });

  return { status: 'completed', runId, intent: intent.name, taskId: task.id, detail: reasoned.decision };
}
