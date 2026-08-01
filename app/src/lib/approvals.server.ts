import 'server-only';
import type { Task } from '@medplum/fhirtypes';
import type { IntentConfig, IntentContext } from './intents/shared';
import { getStore, writeAudit } from './medplum.server';
import { writeEpisodic } from './memory/episodic';
import type { PipelineResult, PipelineStepEvent } from './pipeline';
import type { ReasonOutput } from './reason';
import type { RetrievedSource } from './retrieve';

/**
 * The human-approval layer for gated drafts (denial appeals). The pipeline
 * pauses after `reason` and parks the resumable run here; a staff member
 * approves (optionally with an edited letter) or rejects via copilot tools.
 * Pending state is in-memory: a server restart loses unapproved drafts (their
 * 'requested' Tasks survive as tombstones on the board) — an accepted
 * single-process demo trade-off.
 */

export interface PendingApproval {
  runId: string;
  t0: number;
  triggerRef: string;
  taskId: string;
  intent: IntentConfig;
  ctx: IntentContext;
  reasoned: ReasonOutput;
  sources: RetrievedSource[];
  contextText: string;
  createdAt: string;
}

/** Summary view for the chat layer — never expose ctx, which holds the whole case. */
export interface PendingApprovalSummary {
  runId: string;
  denialCode?: string;
  denialLabel?: string;
  claimRef?: string;
  createdAt: string;
  rationale: string;
  letterRedacted: string;
}

const g = globalThis as unknown as { __pendingApprovals?: Map<string, PendingApproval> };
const pending = (g.__pendingApprovals ??= new Map<string, PendingApproval>());

/** Called by the pipeline gate when an appeal draft is parked for review. */
export function addPending(entry: PendingApproval): void {
  pending.set(entry.runId, entry);
}

export function listPending(): PendingApprovalSummary[] {
  return [...pending.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => ({
      runId: p.runId,
      denialCode: p.ctx.denialCode,
      denialLabel: p.ctx.denialLabel,
      claimRef: p.ctx.claimRef,
      createdAt: p.createdAt,
      rationale: p.reasoned.rationale,
      letterRedacted: p.reasoned.letter,
    }));
}

/** Newest entry, or prefix-match by runId (mirrors latestArtifact's lookup style). */
function resolveEntry(runId?: string): PendingApproval | undefined {
  if (runId) {
    for (const [id, entry] of pending) if (id.startsWith(runId)) return entry;
    return undefined;
  }
  return [...pending.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Approve the pending draft: dispatch, complete the Task, learn. */
export async function approveDraft(
  opts: { runId?: string; editedLetter?: string },
  onStep?: (event: PipelineStepEvent) => void,
): Promise<{ summary: string; result?: PipelineResult }> {
  const entry = resolveEntry(opts.runId);
  if (!entry) {
    return {
      summary:
        'Nothing is awaiting approval. If the board shows a draft in Needs Review, it was lost to a server restart — reject it there or re-fire the denial.',
    };
  }
  // Synchronous delete before any await = the double-approve guard.
  pending.delete(entry.runId);
  const reasoned = opts.editedLetter ? { ...entry.reasoned, letter: opts.editedLetter } : entry.reasoned;

  const store = await getStore();
  const existingTask = (await store.search<Task>('Task', { focus: entry.triggerRef })).find((t) => t.id === entry.taskId);
  // Deferred import breaks the pipeline → approvals → pipeline cycle (same precedent as payerSimulator).
  const { finalizeRun } = await import('./pipeline');
  const step = (name: string, extra = '', data?: Record<string, unknown>) => {
    console.log(`[approval ${entry.runId.slice(0, 8)}] ${name}${extra ? ` ${extra}` : ''}`);
    onStep?.({ step: name, detail: extra.replace(/^—\s*/, ''), data });
  };
  const result = await finalizeRun({ ...entry, reasoned, store, existingTask, step });
  const summary =
    result.status === 'completed'
      ? `Appeal approved${opts.editedLetter ? ' (with your edits)' : ''} and dispatched — ${result.detail ?? ''}. The payer clock starts now.`
      : `Approval could not complete: ${result.detail ?? result.status}`;
  return { summary, result };
}

/** Reject the pending draft: cancel its Task and record the outcome. */
export async function rejectDraft(opts: { runId?: string; reason?: string }): Promise<{ summary: string }> {
  const entry = resolveEntry(opts.runId);
  if (!entry) return { summary: 'Nothing is awaiting approval — there is no draft to reject.' };
  pending.delete(entry.runId);

  const store = await getStore();
  const task = (await store.search<Task>('Task', { focus: entry.triggerRef })).find((t) => t.id === entry.taskId);
  if (task) {
    await store.update<Task>({
      ...task,
      status: 'cancelled',
      lastModified: new Date().toISOString(),
      description: `${entry.intent.label}: draft rejected by reviewer`,
      note: [{ text: opts.reason ?? 'Rejected by reviewer without a stated reason.' }],
    });
  }
  await writeAudit(store, {
    subtype: entry.intent.name,
    description: `Appeal draft rejected by reviewer${opts.reason ? `: ${opts.reason}` : ''}`,
    entities: [entry.triggerRef],
  });
  await writeEpisodic(store, {
    runId: entry.runId,
    intent: entry.intent.name,
    triggerRef: entry.triggerRef,
    claimRef: entry.ctx.claimRef,
    denialCode: entry.ctx.denialCode,
    denialLabel: entry.ctx.denialLabel,
    inputSummary: entry.contextText.slice(0, 400),
    retrievedSourceIds: entry.sources.map((s) => s.id),
    decision: entry.reasoned.decision,
    rationale: opts.reason ?? 'rejected by reviewer',
    keyArguments: entry.reasoned.keyArguments,
    pmids: [],
    actionsTaken: [],
    engine: entry.reasoned.engine,
    outcome: 'rejected',
    redactionCount: 0,
    latencyMs: Date.now() - entry.t0,
    createdAt: new Date().toISOString(),
  });
  return { summary: `Draft rejected — nothing was sent to the payer. The claim can be re-fired for a fresh draft.` };
}
