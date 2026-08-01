import 'server-only';
import { getSurrogateEntries } from './redact';

/**
 * Re-inject PHI from the per-run surrogate map into a final artifact.
 * Server-side only. Fail-closed: if any redaction-style token remains after
 * substitution (e.g. the LLM invented [NAME_9]), the artifact is rejected
 * rather than sent half-redacted.
 */

const TOKEN_RE = /\[(?:NAME|DOB|MRN|PHONE|EMAIL|ADDRESS|ID|SSN)_\d+\]/g;

export class DeredactError extends Error {
  constructor(
    message: string,
    readonly unresolvedTokens: string[],
  ) {
    super(message);
    this.name = 'DeredactError';
  }
}

export function deredact(runId: string, text: string): string {
  const entries = getSurrogateEntries(runId);
  if (!entries) {
    throw new DeredactError(`No surrogate map for run ${runId}`, []);
  }
  let out = text;
  for (const [token, value] of entries) {
    out = out.split(token).join(value);
  }
  const leftover = out.match(TOKEN_RE);
  if (leftover && leftover.length > 0) {
    const unique = [...new Set(leftover)];
    throw new DeredactError(
      `De-redaction failed closed: unresolved tokens ${unique.join(', ')}`,
      unique,
    );
  }
  return out;
}
