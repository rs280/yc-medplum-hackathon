# CLAUDE.md

Standing instructions for all Claude Code sessions in this repo. Read fully before writing code.

---

## 1. Philosophy

Think before you code. Before any implementation:

1. State the plan in 1–3 sentences.
2. Choose the simplest design that fully solves the problem.
3. Prefer the intuitive solution over the clever one — if two approaches work, pick the one a new engineer understands fastest.

Optimize for maintainability first, performance second. Never trade clarity for brevity tricks.

---

## 2. Coding Principles

### Object-Oriented Design
- Encapsulation, single responsibility, clear interfaces — applied everywhere, not just where convenient.
- Business logic, API clients, and data transformations live in classes or well-defined modules under `lib/` or `packages/` — never inline in components or route handlers.
- Each class does one thing. If describing a class requires the word "and", split it.
- Expose small public interfaces; keep helpers private.
- React components stay functions (framework requirement), but treat each one like an object: single responsibility, props as its interface, internal state encapsulated.

### Modularity
- One module = one concern = one reason to change.
- Dependencies point inward: UI → domain → data. Never the reverse.
- Exactly one implementation per cross-cutting concern (one serializer, one state machine, one API client per vendor). Duplicate implementations are a bug, not a convenience.
- A module that imports from more than ~5 other modules is doing too much.

### Naming
- Names must be self-explanatory: `activeResidentCount`, not `cnt`; `fetchEligibilityResponse()`, not `getData()`.
- Booleans read as questions: `isLoading`, `hasCoverage`, `shouldRetry`.
- No abbreviations unless universally known (`id`, `url`, `api`, `npi`).
- Domain terms match the domain exactly — if the spec says `837I`, the code says `claim837I`, not `instClaim`.

### Comments
- Concise single-line comments above non-obvious logic — explain **why**, not **what**.
- Every exported function and public method gets a one-line purpose comment.
- No redundant comments (`// increment i`). No stale comments — update or delete them when the code changes.
- Comments that restate the function name are noise. Delete them.

### Logic
- Most direct control flow possible: early returns over nested conditionals.
- Functions stay short (~30 lines). Extract when longer.
- No premature abstraction — duplicate once, abstract on the third occurrence.
- Handle errors explicitly at boundaries (API calls, file I/O, user input). Never swallow exceptions silently.
- Validate at the edge; trust internal callers.

---

## 3. Workflow

- Before implementing, briefly outline the approach and wait for confirmation on anything ambiguous.
- Make the **smallest change** that accomplishes the task. Do not refactor unrelated code.
- Never add dependencies, files, or scaffolding beyond what the task requires.
- Re-confirm affected code by symbol/grep, not by remembered line numbers.
- After coding, self-review: naming, comments, dead code, edge cases, error paths.

---

## 4. Documentation References

### Medplum — headless EHR / FHIR datastore
Docs root: https://www.medplum.com/docs

| Task | Reference |
|---|---|
| FHIR resource modeling | https://www.medplum.com/docs/fhir-basics |
| CRUD + datastore | https://www.medplum.com/docs/fhir-datastore |
| Search semantics | https://www.medplum.com/docs/search |
| Auth & access control | https://www.medplum.com/docs/auth · https://www.medplum.com/docs/access |
| Bots / automation | https://www.medplum.com/docs/bots |
| Subscriptions (webhooks) | https://www.medplum.com/docs/subscriptions |
| React components | https://www.medplum.com/docs/react |
| TypeScript SDK | https://www.medplum.com/docs/sdk/core |
| REST API reference | https://www.medplum.com/docs/api |
| Billing / RCM | https://www.medplum.com/docs/billing |
| **Medplum ↔ Stedi integration** | https://www.medplum.com/docs/integration/stedi |
| Guidance for AI coding tools | https://www.medplum.com/docs/building-with-ai-coding-assistants |



### Deepgram — speech-to-text / voice
Docs root: https://developers.deepgram.com/home

| Task | Reference |
|---|---|
| First API request | https://developers.deepgram.com/guides/fundamentals/make-your-first-api-request |
| Auth (incl. token-based) | https://developers.deepgram.com/guides/fundamentals/authenticating · https://developers.deepgram.com/guides/fundamentals/token-based-authentication |
| Pre-recorded transcription | https://developers.deepgram.com/docs/pre-recorded-audio |
| Live streaming transcription | https://developers.deepgram.com/docs/live-streaming-audio |
| Models & languages | https://developers.deepgram.com/docs/models-languages-overview |
| Voice Agent API | https://developers.deepgram.com/docs/voice-agent |
| Text-to-speech | https://developers.deepgram.com/docs/text-to-speech |
| Audio intelligence | https://developers.deepgram.com/docs/audio-intelligence |
| Supported audio formats | https://developers.deepgram.com/docs/supported-audio-formats |
| Concurrency / rate limits | https://developers.deepgram.com/docs/working-with-concurrency-rate-limits |
| API reference | https://developers.deepgram.com/reference/deepgram-api-overview |
| JS SDK | https://github.com/deepgram/deepgram-js-sdk |


### Stedi — healthcare clearinghouse / X12 EDI
Docs root: https://www.stedi.com/docs/healthcare

| Task | Reference |
|---|---|
| Eligibility (270/271) | https://www.stedi.com/docs/healthcare/send-eligibility-checks |
| Interpreting eligibility responses | https://www.stedi.com/docs/healthcare/eligibility-active-coverage-benefits |
| Coordination of benefits | https://www.stedi.com/docs/healthcare/coordination-of-benefits |
| Insurance discovery | https://www.stedi.com/docs/healthcare/insurance-discovery |
| Institutional claims (837I) | https://www.stedi.com/docs/healthcare/submit-institutional-claims |
| Professional claims (837P) | https://www.stedi.com/docs/healthcare/submit-professional-claims |
| Claim responses (277CA, 835 ERA) | https://www.stedi.com/docs/healthcare/receive-claim-responses |
| Claim status (276/277) | https://www.stedi.com/docs/healthcare/check-claim-status |
| Resubmit / cancel claims | https://www.stedi.com/docs/healthcare/resubmit-cancel-claims |
| Webhooks & event destinations | https://www.stedi.com/docs/healthcare/configure-webhooks · https://www.stedi.com/docs/healthcare/event-destinations-event-types |
| Supported payers | https://www.stedi.com/docs/healthcare/supported-payers |
| Enrollment | https://www.stedi.com/docs/healthcare/transaction-enrollment |
| Code lists | https://www.stedi.com/docs/healthcare/claims-code-lists · https://www.stedi.com/docs/healthcare/eligibility-code-lists |
| Test mode | https://www.stedi.com/docs/healthcare/test-mode |
| API reference | https://www.stedi.com/docs/healthcare/api-reference |

