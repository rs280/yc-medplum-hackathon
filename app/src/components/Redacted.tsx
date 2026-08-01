import type { ReactNode } from 'react';

/**
 * Renders text that may contain PHI placeholder tokens ([NAME_1], [DOB_1], …)
 * and citation markers ([MOSS:id], [PMID:id]) with visible highlighting — the
 * whole point of the demo is to SHOW redaction and grounded citation
 * happening, not just claim it in a stat tile. Pure function, no hooks, so it
 * works in server components (dashboard) and client components (copilot).
 */

const TOKEN_RE = /(\[(?:MOSS|PMID):[^\]\s]+\]|\[[A-Z][A-Z0-9_]*_\d+\])/g;

/** `String.split` with a capturing group alternates [text, match, text, match, …] — odd indices are matches. */
export function renderRedacted(text: string): ReactNode[] {
  return text.split(TOKEN_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    const isCitation = part.startsWith('[MOSS:') || part.startsWith('[PMID:');
    return (
      <span key={i} className={isCitation ? 'cite-tok' : 'phi-tok'}>
        {part}
      </span>
    );
  });
}

export function Redacted({ text }: { text: string }): ReactNode {
  return <>{renderRedacted(text)}</>;
}
