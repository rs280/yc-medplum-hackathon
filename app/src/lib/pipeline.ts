import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ClaimResponse, Communication, Resource, Task } from '@medplum/fhirtypes';
import { act } from './act';
import { DeredactError, deredact } from './deredact';
import { parseIntent } from './intents';
import { getStore, writeAudit } from './medplum.server';
import { applyOutcomeFeedback, markPriorAppealLost } from './memory/feedback';
import { writeEpisodic, type EpisodicRecord } from './memory/episodic';
import { hydrateLearnedPlaybooks, registerAttempt } from './memory/playbook';
import { reason } from './reason';
import { releaseRun, startRedaction } from './redact';
import { retrieve } from './retrieve';

/**
 * THE shared pipeline. One code path for all four agents; branching happens
 * only in parse-intent (step 1) and act (step 6 dispatch).
 *
 *   1. parse intent      FHIR event → intent config
 *   2. redact PHI        deterministic tokens + per-run surrogate map
 *   3. retrieve          Moss (all intents) + PubMed (denial-appeal only)
 *   4. reason            LLM on redacted context, citation-validated JSON
 *   5. de-redact         re-inject PHI server-side (fail closed)
 *   6. write outcome     Task + Communication + AuditEvent, dispatch Stedi/Twilio
 *   7. learn             episodic record + playbook aggregate + Moss re-index
 */

export interface PipelineResult {
  status: 'completed' | 'skipped' | 'ignored' | 'feedback' | 'failed';
  runId?: string;
  intent?: string;
  detail?: string;
  taskId?: string;
}

const TASK_SYSTEM = 'https://autonomous-backoffice.dev/task';

export async function runPipeline(resource: Resource): Promise<PipelineResult> {
  const t0 = Date.now();
  const runId = randomUUID();
  const triggerRef = `${resource.resourceType}/${resource.id}`;
  const step = (name: string, extra = '') =>
    console.log(`[pipeline ${runId.slice(0, 8)}] ${name} (+${Date.now() - t0}ms)${extra ? ` ${extra}` : ''}`);

  const store = await getStore();

  // 1 ── parse intent
  const parsed = parseIntent(resource);
  if (parsed.kind === 'ignore') {
    step('ignored', `— ${parsed.reason}`);
    return { status: 'ignored', detail: parsed.reason };
  }
  if (parsed.kind === 'feedback') {
    const result = await applyOutcomeFeedback(store, resource as ClaimResponse);
    step('feedback', `— ${result.detail}`);
    return { status: 'feedback', detail: result.detail };
  }
  const intent = parsed.intent;
  step(`parse-intent → ${intent.name}`, `for ${triggerRef}`);

  // Idempotency: never double-process an event (Task-by-focus).
  const existingTasks = await store.search<Task>('Task', { focus: triggerRef });
  if (existingTasks.some((t) => t.code?.coding?.some((c) => c.code === intent.taskCode))) {
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
    step('redact', `— ${session.replacements} PHI value(s) tokenized`);

    // 3 ── retrieve (Moss for all; PubMed for denial-appeal only)
    await hydrateLearnedPlaybooks(store);
    const sources = await retrieve(intent, { criteriaQuery, playbookQuery, pubmedTerm });
    step('retrieve', `— ${sources.length} source(s)`);

    // 4 ── reason + act plan (redacted context only; citations validated)
    const reasoned = await reason(intent, contextText, sources, ctx.meta);
    step('reason', `— ${reasoned.engine}: ${reasoned.decision}`);

    // 5 ── de-redact final artifact server-side (fail closed)
    let finalArtifact = '';
    try {
      finalArtifact = reasoned.letter ? deredact(runId, reasoned.letter) : '';
    } catch (err) {
      if (err instanceof DeredactError) {
        step('de-redact FAILED CLOSED', `— ${err.message}`);
        await store.create<Task>({
          resourceType: 'Task',
          status: 'failed',
          intent: 'order',
          code: { coding: [{ system: TASK_SYSTEM, code: intent.taskCode }], text: intent.label },
          focus: { reference: triggerRef },
          for: ctx.patientRef ? { reference: ctx.patientRef } : undefined,
          authoredOn: new Date().toISOString(),
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
          redactionCount: session.replacements,
          latencyMs: Date.now() - t0,
          createdAt: new Date().toISOString(),
        });
        releaseRun(runId);
        return { status: 'failed', runId, intent: intent.name, detail: err.message };
      }
      throw err;
    }
    step('de-redact', '— PHI re-injected server-side');

    // 6 ── act (Stedi/Twilio are the only permitted PHI receivers) + write outcome
    const actions = await act(store, intent, ctx, reasoned, finalArtifact);
    step('act', `— ${actions.map((a) => a.action).join(', ') || 'no dispatch'}`);

    const communication = await store.create<Communication>({
      resourceType: 'Communication',
      status: 'completed',
      subject: ctx.patientRef ? { reference: ctx.patientRef } : undefined,
      sent: new Date().toISOString(),
      category: [{ text: intent.artifactLabel }],
      payload: finalArtifact ? [{ contentString: finalArtifact }] : [{ contentString: reasoned.rationale }],
    });

    const task = await store.create<Task>({
      resourceType: 'Task',
      status: 'completed',
      intent: 'order',
      code: { coding: [{ system: TASK_SYSTEM, code: intent.taskCode }], text: intent.label },
      focus: { reference: triggerRef },
      for: ctx.patientRef ? { reference: ctx.patientRef } : undefined,
      authoredOn: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      description: `${intent.label}: ${reasoned.decision}`,
      note: [
        { text: reasoned.rationale },
        { text: `Actions: ${actions.map((a) => `${a.action}${a.simulated ? ' (simulated)' : ''} — ${a.detail}`).join(' | ')}` },
        { text: `Citations: ${reasoned.citations.join(', ') || 'none'} · PHI tokens redacted: ${session.replacements}` },
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
      description: `${intent.label} completed: ${reasoned.decision} (${actions.length} action(s), ${reasoned.citations.length} citation(s), ${session.replacements} PHI tokens redacted)`,
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
      redactionCount: session.replacements,
      latencyMs: Date.now() - t0,
      createdAt: new Date().toISOString(),
    };
    await writeEpisodic(store, record);
    if (intent.name === 'denial-appeal' && ctx.denialCode) {
      await registerAttempt(store, ctx.denialCode, ctx.denialLabel ?? ctx.denialCode);
    }
    step('learn', `— episodic written, outcome=${record.outcome}`);

    releaseRun(runId);
    return { status: 'completed', runId, intent: intent.name, taskId: task.id, detail: reasoned.decision };
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
