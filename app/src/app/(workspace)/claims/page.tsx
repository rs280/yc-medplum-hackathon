import { claimsBoard, type ClaimStage } from '@/lib/workspace.server';
import { Stagger } from '@/components/anim';

export const dynamic = 'force-dynamic';

/**
 * Claims board: the revenue cycle as a live kanban. Cards move columns as the
 * agents work — copilot fires a denial → the card jumps to Denied, the appeal
 * completes → Appealed, payer approves → Paid. Stage is derived purely from
 * FHIR resources (Claim + ClaimResponse + Task), so it can't drift from
 * reality.
 */

const STAGES: Array<{ stage: ClaimStage; label: string; hint: string }> = [
  { stage: 'ready', label: 'Ready', hint: 'awaiting triage' },
  { stage: 'submitted', label: 'Submitted', hint: 'with the payer' },
  { stage: 'denied', label: 'Denied', hint: 'agent will appeal' },
  { stage: 'appealed', label: 'Appealed', hint: 'decision pending' },
  { stage: 'paid', label: 'Paid', hint: 'won / reprocessed' },
];

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export default async function ClaimsPage() {
  const cards = await claimsBoard();
  const totalBilled = cards.reduce((s, c) => s + (c.amount ?? 0), 0);
  const paid = cards.filter((c) => c.stage === 'paid').reduce((s, c) => s + (c.amount ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <h1>Claims &amp; Billing</h1>
        <p>
          ${totalBilled.toLocaleString()} billed · ${paid.toLocaleString()} recovered — cards move as the agents work
          the revenue cycle.
        </p>
      </div>

      <div className="board">
        {STAGES.map(({ stage, label, hint }) => {
          const col = cards.filter((c) => c.stage === stage);
          return (
            <div key={stage} className={`board-col stage-${stage}`}>
              <div className="board-col-head">
                <span className="board-col-label">{label}</span>
                <span className="board-col-count">{col.length}</span>
              </div>
              <div className="board-col-hint">{hint}</div>
              <Stagger signal={`${stage}:${col.length}`}>
                <div className="board-cards">
                  {col.length === 0 ? (
                    <div className="board-empty">—</div>
                  ) : (
                    col.map((c) => (
                      <div key={c.id} className="board-card">
                        <div className="board-card-top">
                          <span className="board-card-id">{c.identifier}</span>
                          {c.amount != null && <span className="board-card-amt">${c.amount.toLocaleString()}</span>}
                        </div>
                        {c.procedure && <div className="board-card-proc">{c.procedure}</div>}
                        <div className="board-card-meta">
                          {c.patientName} · {c.payer}
                        </div>
                        <div className="board-card-foot">
                          {c.denialCode && (
                            <span className="badge tone-bad" title={c.denialLabel}>
                              {c.denialCode}
                            </span>
                          )}
                          <span className="board-card-when">{c.updatedAt ? fmtWhen(c.updatedAt) : ''}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </Stagger>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h2>Try it</h2>
        <p className="empty">
          Ask the copilot: <em>“the payer denied claim 2 for medical necessity”</em> → watch the card move to Denied,
          then Appealed as the agent drafts and files. <em>“the payer approved claim 2”</em> moves it to Paid and
          teaches the playbook.
        </p>
      </div>
    </>
  );
}
