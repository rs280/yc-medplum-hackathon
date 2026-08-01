/**
 * Branded string type for de-identified text.
 *
 * Only `redact.ts` may mint values of this type. `retrieve()` and `reason()`
 * accept ONLY `Redacted<string>`, so passing a raw string (potential PHI) to
 * any outbound surface (Moss, PubMed, LLM) is a compile-time error.
 */
declare const RedactedBrand: unique symbol;

export type Redacted<T extends string = string> = T & {
  readonly [RedactedBrand]: 'redacted';
};
