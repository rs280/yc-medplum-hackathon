import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ClaimResponse, Communication, Resource, Task } from '@medplum/fhirtypes';
import type { Redacted } from '@/types/redacted';
import { act } from './act';
import { addPending } from './approvals.server';
import { DeredactError, deredact } from './deredact';
import { parseIntent } from './intents';
import type { IntentConfig, IntentContext } from './intents/shared';
import { getStore, writeAudit, type FhirStore } from './medplum.server';
import { applyOutcomeFeedback, markPriorAppealLost } from './memory/feedback';
import { writeEpisodic, type EpisodicRecord } from './memory/episodic';
import { hydrateLearnedPlaybooks, registerAttempt } from './memory/playbook';
import { reason, type ReasonOutput } from './reason';
import { releaseRun, startRedaction } from './redact';
import { retrieve, type RetrievedSource } from './retrieve';

/**
 * THE shared pipeline. One code path for all four agents; branching happens
 * only in parse-intent (step 1) and act (step 6 dispatch).
 *
 *   1. parse intent      FHIR event → intent config
 *   2. redact PHI        deterministic tokens + per-run surrogate map
 *   3. retrieve          Moss (all intents) + PubMed (denial-appeal only)
 *   4. reason            LLM on redacted context, citation-validated JSON
 *   5. de-redact         re-inject PHI server-side (fail closed)
 *   6. write outcome     Task + Communication + AuditEvent, dispatch via Stedi
 *   7. learn             episodic record + playbook aggregate + Moss re-index
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
 * than just the final result. `data` is always PHI-free: redacted content,
 * ids, counts — never the de-redacted artifact.
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

    // 2 ── redact PHI (nothing outbound may contain raw PHI)
    const session = startRedaction(runId, ctx.phiResources);
    const contextText = session.redact(ctx.contextTextRaw);
    const criteriaQuery = session.redact(ctx.queryRaw);
    const playbookQuery = session.redact(`${ctx.denialCode ?? ''} ${ctx.queryRaw}`.trim());
    const pubmedTerm = ctx.pubmedTermRaw ? session.redact(ctx.pubmedTermRaw) : undefined;
    step('redact', `— ${session.replacements} PHI value(s) tokenized`, {
      redactionCount: session.replacements,
      contextRedacted: (contextText as string).slice(0, 2000),
    });

    // 3 ── retrieve (Moss for all; PubMed for denial-appeal only)
    await hydrateLearnedPlaybooks(store);
    const sources = await retrieve(intent, { criteriaQuery, playbookQuery, pubmedTerm });
    step('retrieve', `— ${sources.length} source(s)`, {
      sources: sources.map((s) => ({ id: s.id, kind: s.kind, title: s.title, snippet: s.text.slice(0, 220) })),
    });

    // 4 ── reason + act plan (redacted context only; citations validated)
    const reasoned = await reason(intent, contextText, sources, ctx.meta);
    step('reason', `— ${reasoned.engine}: ${reasoned.decision}`, {
      engine: reasoned.engine,
      decision: reasoned.decision,
      rationale: reasoned.rationale,
      keyArguments: reasoned.keyArguments,
      citations: reasoned.citations,
      letterRedacted: reasoned.letter,
    });

    // Human-in-the-loop gate: appeal letters wait for staff sign-off before
    // anything is de-redacted or transmitted. The surrogate map is deliberately
    // kept alive (no releaseRun) so approval can de-redact later by runId.
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
        replacements: session.replacements,
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

    // 5-7 ── de-redact, act, write outcome, learn (shared with the approval resume path)
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
      replacements: session.replacements,
      step,
    });
  } catch (err) {
    releaseRun(runId);
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
  contextText: Redacted;
  replacements: number;
  /** The 'requested' approval Task to complete/fail in place of creating a fresh one. */
  existingTask?: Task;
  step: (name: string, extra?: string, data?: Record<string, unknown>) => void;
}

/**
 * Steps 5-7: de-redact (fail closed) → act → Task/Communication/audit → learn.
 * Called inline by runPipeline for autonomous intents, and by the approvals
 * module when a human approves a gated draft. Always releases the run.
 */
export async function finalizeRun(input: FinalizeInput): Promise<PipelineResult> {
  const { store, runId, t0, triggerRef, intent, ctx, reasoned, sources, contextText, replacements, existingTask, step } = input;

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

  // 5 ── de-redact final artifact server-side (fail closed)
  let finalArtifact = '';
  try {
    finalArtifact = reasoned.letter ? deredact(runId, reasoned.letter) : '';
  } catch (err) {
    if (err instanceof DeredactError) {
      step('de-redact FAILED CLOSED', `— ${err.message}`);
      await writeTask({
        status: 'failed',
        description: `${intent.label}: rejected fail-closed (unresolved redaction tokens)`,
        note: [{ text: err.message }],
      });
      await writeAudit(store, {
        subtype: intent.name,
        description: `Artifact rejected fail-closed: ${err.message}`,
        outcome: '8',
        entities: [triggerRef],
      });
      await writeEpisodic(store, {
        runId,
        intent: intent.name,
        triggerRef,
        claimRef: ctx.claimRef,
        denialCode: ctx.denialCode,
        denialLabel: ctx.denialLabel,
        inputSummary: (contextText as string).slice(0, 400),
        retrievedSourceIds: sources.map((s) => s.id),
        decision: 'failed',
        rationale: err.message,
        keyArguments: [],
        pmids: [],
        actionsTaken: [],
        engine: reasoned.engine,
        outcome: 'failed',
        redactionCount: replacements,
        latencyMs: Date.now() - t0,
        createdAt: new Date().toISOString(),
      });
      releaseRun(runId);
      return { status: 'failed', runId, intent: intent.name, detail: err.message };
    }
    throw err;
  }
  // De-redacted `finalArtifact` carries real PHI from here on — it is used
  // only for the act() dispatch below and never appears in a step event.
  step('de-redact', '— PHI re-injected server-side (for dispatch only — never surfaced)', {
    artifactLength: finalArtifact.length,
  });

  // 6 ── act (Stedi is the only permitted PHI receiver) + write outcome
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
      { text: `Citations: ${reasoned.citations.join(', ') || 'none'} · PHI tokens redacted: ${replacements}` },
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
    description: `${intent.label} completed: ${reasoned.decision} (${actions.length} action(s), ${reasoned.citations.length} citation(s), ${replacements} PHI tokens redacted)`,
    entities: [triggerRef, `Task/${task.id}`, `Communication/${communication.id}`],
  });

  // 7 ── learn
  const gapsClosed = actions.filter((a) => a.action === 'care-gap-closed').length;
  const record: EpisodicRecord = {
    runId,
    intent: intent.name,
    triggerRef,
    claimRef: ctx.claimRef,
    denialCode: ctx.denialCode,
    denialLabel: ctx.denialLabel,
    inputSummary: (contextText as string).slice(0, 400),
    retrievedSourceIds: sources.map((s) => s.id),
    decision: reasoned.decision,
    rationale: reasoned.rationale,
    letterRedacted: reasoned.letter || undefined,
    keyArguments: reasoned.keyArguments,
    pmids: reasoned.citations.filter((c) => c.startsWith('PMID:')).map((c) => c.slice(5)),
    actionsTaken: actions.map((a) => a.action),
    gapsClosed: gapsClosed || undefined,
    engine: reasoned.engine,
    outcome: intent.name === 'denial-appeal' ? 'pending' : 'closed',
    redactionCount: replacements,
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

  releaseRun(runId);
  return { status: 'completed', runId, intent: intent.name, taskId: task.id, detail: reasoned.decision };
}
