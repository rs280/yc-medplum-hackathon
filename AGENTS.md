# AGENTS.md — YC x Medplum Hackathon Build

This file is the authoritative build specification for the hackathon project **"The autonomous back office"** — five FHIR-triggered AI agents that run the revenue cycle (claim triage, prior-auth docs, denial appeal) and coordinate patient care (discharge coordinator, care-gap). Built for the YC x Medplum Hackathon (Aug 1, 2026, YC SF).

A coding agent should treat every section below as a hard requirement unless explicitly marked `[OPTIONAL]` or `[DEFERRED]`. Work through `BUILD PHASES` in order. Never skip Phase 0.

**Priority order:** Build the **appeal engine with prevention** first (the money centerpiece), then the **outbound discharge call with care-gap** (the emotional live moment). The prior-auth docs agent is a timeline element — build last.

---

## 1. Project Overview

**One-liner:** An autonomous back office — five FHIR-triggered agents that prevent denials, win appeals, and call patients to coordinate care.

### The five agents (one engine, five handlers)

| Agent | Trigger (FHIR event) | What it does autonomously |
|-------|----------------------|---------------------------|
| **Claim Triage** (prevention) | `Claim` ready to submit | Checks claim against payer criteria (Moss), fixes gaps pre-submission, submits clean |
| **Prior-Auth Docs** | `ServiceRequest` needs auth | Completes missing documentation, submits via Stedi |
| **Denial Appeal** (cure) | `ClaimResponse` denied | Parses reason, retrieves payer criteria (Moss), drafts appeal (LLM), resubmits, tracks win rate |
| **Discharge Coordinator** | `Encounter` discharged | Calls patient within 24h, catches red flags, books follow-up |
| **Care-Gap Agent** | Patient overdue for preventive care | Finds gap, calls patient, books + verifies coverage — runs inside the discharge call |

### The unifying pattern (THE core architecture)

```
FHIR event → agent handler → REDACT PHI → retrieve context (Moss) → reason (LLM, grounded) → act (Stedi/Twilio/Medplum) → write outcome → learn (memory)
```

One Node worker. One event router. Five handler configs. Each agent advances a `Task` through a state machine and updates the learning ledger (memory) on completion. **Every external call (LLM, Moss, PubMed) sees de-identified data only — PHI is redacted on the way out and re-injected on the way back.**

### Demo scope (locked)

| Moment | Live? | Why |
|--------|-------|-----|
| Claim triage catches + fixes gap (prevention) | ✅ Live | The "before it fails" moment |
| Denial lands → agent fights → APPROVED (cure) | ✅ Live | The centerpiece |
| Discharge call (outbound, live phone) | ✅ Live | The emotional peak |
| Care-gap surfaced + booked in same call | ✅ Live | One call, two jobs |
| Prior-auth docs agent | 🟡 Timeline | Same engine, dashboard only |
| Win-rate learning dashboard | ✅ On screen | The closer |

**Non-goals:** No real EHR integration, no production HIPAA BAA (fake PHI only), no "humanize" of appeal prose beyond a reasonable template, no UI beyond the dashboard page.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                 THE AGENT PLATFORM (one engine)                     │
└──────────────────────────────────────────────────────────────────────┘
                    │  Medplum Subscriptions (event stream)
                    │
     ┌──────────────┼──────────────────────┬────────────────┐
     ▼              ▼                      ▼                ▼
 Claim created   ClaimResponse      Encounter          ServiceRequest
     │             denied           discharged        needs prior auth
     ▼              ▼                      ▼                ▼
 ┌────────┐    ┌──────────┐    ┌──────────────────┐   ┌──────────────┐
 │ Claim  │    │ Denial   │    │ Discharge Coord  │   │ Prior-Auth  │
 │ Triage │    │ Appeal   │    │ + Care-Gap Agent │   │ Docs Agent  │
 └────┬───┘    └────┬─────┘    └────────┬─────────┘   └──────┬───────┘
      │             │                   │                    │
      │     ┌───────▼───────────────────▼────────────────────▼──────┐
      └────▶│   THE AGENT PIPELINE (shared)                        │
            │   1. Parse intent        ← FHIR event                 │
            │   2. REDACT PHI          ← de-identify before outbound│
            │   3. Retrieve criteria   ← Moss + PubMed evidence     │
            │   4. Reason + act        ← LLM → Stedi / Twilio       │
            │   5. De-redact           ← re-inject PHI              │
            │   6. Write outcome       → Medplum Task               │
            │   7. Learn               → memory ledger               │
            └───────┬───────────────────────────────────────────────┘
                    │
                    ▼
     ┌──────────────────────────────────────────────┐
     │  Learning dashboard: win rate by denial      │
     │  reason, gaps closed, calls answered          │
     └──────────────────────────────────────────────┘

Outbound call path (discharge + care-gap):
  Agent decides to call → Twilio REST calls.create → patient's phone rings
    → Twilio GETs /twilio/outbound-voice → returns TwiML <Connect><Stream>
    → Twilio connects audio to our /stream WS → Deepgram Voice Agent session
    → function calls → Medplum (book follow-up), Stedi (verify coverage),
      Moss (care protocols), Twilio (SMS)
```

### Data flow notes (important gotchas)

- **The engine is one pipeline with pluggable handlers.** Do NOT build five separate systems. `pipeline.ts` orchestrates; `function-handlers.ts` routes. This is both the build strategy AND the product story.
- **Stedi test mode cannot produce a real denial** — 835 ERAs always pay all lines; denials only occur with production claims. The denial payload comes from the **deterministic denial simulator** (§5.3) and is **anchored to a real signal** (`authOrCertIndicator: Y` from eligibility). The loop is real; only the denial payload is simulated. Disclose this in the pitch.
- **Outbound calls differ from inbound.** The agent *initiates* via Twilio REST; Twilio then calls back to our webhook to get TwiML and opens the audio stream. The `/stream` bridge is identical to inbound (μ-law passthrough). Test the outbound trigger path before demo day — it's the riskiest live moment.
- **No audio transcode required** — pass μ-law straight through (details in §5.5).

---

## 3. Tech Stack (locked)

| Layer | Technology | Version / Notes |
|-------|-----------|-----------------|
| Language | TypeScript | strict mode |
| Runtime | Node.js | ≥ 20 |
| Server | Fastify (or Express) | WebSocket support required |
| Workflow state | Medplum FHIR R4 | Claim, ClaimResponse, Task, Encounter, ServiceRequest, Patient, Appointment, Coverage |
| Triggers | Medplum Subscriptions | rest-hook → our server |
| EDI | Stedi | plain HTTP (fetch) |
| Search | Moss | `@moss-dev/moss` |
| Medical evidence | PubMed E-utilities API | plain HTTP (fetch), free, no API key |
| Privacy | In-house `redact.ts` | PHI → tokens before any external call; de-redact on return |
| LLM | `gpt-4o-mini` via `openai` SDK | env-configurable; mock fallback required |
| Voice | Deepgram Voice Agent API | `@deepgram/sdk` |
| Telephony | Twilio | `twilio` SDK + Media Streams |

Do NOT add databases, caches, queues, or message brokers. Medplum FHIR IS the database and the task queue. Deployment surface: **one Node server + Medplum cloud + sponsor APIs**.

---

## 4. Environment Variables

Create a `.env` file at repo root (git-ignored). Required unless marked `[OPTIONAL]`.

```bash
# ── Agent Engine ─────────────────────────────────────────
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# ── Stedi ────────────────────────────────────────────────
STEDI_API_KEY=key_...                                      # TEST mode key
STEDI_TRADING_PARTNER_ID=60054                             # Aetna test payer service id
STEDI_MODE=simulate                                        # live | simulate (deterministic denial simulator)

# ── Medplum ──────────────────────────────────────────────
MEDPLUM_BASE_URL=https://api.medplum.com/
MEDPLUM_CLIENT_ID=
MEDPLUM_CLIENT_SECRET=
MEDPLUM_PROJECT_ID=

# ── Moss ─────────────────────────────────────────────────
MOSS_PROJECT_ID=
MOSS_PROJECT_KEY=

# ── Voice / Telephony ────────────────────────────────────
DEEPGRAM_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=+1...
TWILIO_WEBHOOK_BASE_URL=https://your-public-ngrok-url

# ── Server ───────────────────────────────────────────────
PORT=3000
```

---

## 5. Sponsor API Integration Specs (read this before writing code)

### 5.1 Medplum (FHIR) — THE WORKFLOW ENGINE

**Docs:** https://www.medplum.com/docs/api

#### Client setup

```typescript
import { MedplumClient } from '@medplum/core';

export const medplum = new MedplumClient({
  baseUrl: process.env.MEDPLUM_BASE_URL,
  clientId: process.env.MEDPLUM_CLIENT_ID,
  clientSecret: process.env.MEDPLUM_CLIENT_SECRET,
});
```

#### The revenue-cycle resources (triage + appeal)

**`Claim`** — the submitted claim:

```typescript
import { Claim } from '@medplum/fhirtypes';

const claim = await medplum.createResource<Claim>({
  resourceType: 'Claim',
  status: 'active',
  type: { coding: [{ code: 'professional' }] },
  use: 'claim',
  patient: { reference: 'Patient/<id>' },
  provider: { reference: 'Organization/<id>' },
  priority: { coding: [{ code: 'normal' }] },
  item: [{ sequence: 1, productOrService: { coding: [{ code: 'MRI', display: 'MRI of brain' }] } }],
});
```

**`ClaimResponse`** — the payer's adjudication. ⚠️ FHIR `outcome` valid values are `queued | complete | error | partial` (no "denied"), and the `adjudication` code system has no "denied" code (only `submitted | copay | eligible | deductible | unallocdeduct | eligpercent | tax | benefit`). Represent denial canonically:

```typescript
import { ClaimResponse } from '@medplum/fhirtypes';

const response = await medplum.createResource<ClaimResponse>({
  resourceType: 'ClaimResponse',
  status: 'active',
  outcome: 'error',                                     // queued | complete | error | partial
  request: { reference: 'Claim/<id>' },
  disposition: 'Medical necessity not established for the requested service.',
  processNote: [{ number: 1, text: 'Denied: Medical necessity not established.' }],
  error: [{ code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication-error', code: 'Missing', display: 'Medical necessity' }] } }],
  item: [{
    sequence: 1,
    adjudication: [{
      category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication', code: 'benefit' }] },
      amount: { value: 0, currency: 'USD' },            // zeroed benefit = not paid = denied line
    }],
  }],
});
```

**Denial detection helper** (used by the webhook):

```typescript
export function isDenied(cr: ClaimResponse): boolean {
  const texts = [cr.disposition || '', ...(cr.processNote || []).map(n => n.text || '')].join(' ').toLowerCase();
  const unpaid = (cr.item || []).some(i =>
    (i.adjudication || []).some(a => {
      const code = a.category?.coding?.map(c => c.code).join(',');
      return code === 'benefit' && (a.amount?.value ?? 1) === 0;
    }));
  return unpaid || cr.outcome === 'error' || /deni|reject|not cover|disallow/.test(texts);
}
```

#### The care resources (discharge + care-gap)

**`Encounter`** — a hospital/clinic visit. Discharge = `status: 'finished'`:

```typescript
import { Encounter } from '@medplum/fhirtypes';

const encounter = await medplum.createResource<Encounter>({
  resourceType: 'Encounter',
  status: 'finished',                                   // ← triggers Discharge Coordinator
  class: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }] },
  subject: { reference: 'Patient/<id>' },
  period: { start: '2026-07-29T09:00:00Z', end: '2026-07-30T11:00:00Z' },
  type: [{ coding: [{ code: 'surgery', display: 'Outpatient surgery' }] }],
  diagnosis: [{ condition: { display: 'Laparoscopic cholecystectomy' } }],
});
```

**`ServiceRequest`** — a proposed procedure/screening. **Care-gap** = a ServiceRequest that's overdue (authoredOn + past dueDate) OR a known-missing screening:

```typescript
import { ServiceRequest } from '@medplum/fhirtypes';

const mammogram = await medplum.createResource<ServiceRequest>({
  resourceType: 'ServiceRequest',
  status: 'active',
  intent: 'order',
  subject: { reference: 'Patient/<id>' },
  code: { coding: [{ code: 'mammogram', display: 'Screening mammogram' }] },
  authoredOn: '2025-06-01',
  occurrenceDateTime: '2025-06-15',                     // past due → care gap
  doNotPerform: false,
  reasonCode: [{ text: 'Routine preventive screening' }],
});
```

#### The Task state machine (one per agent action)

```typescript
import { Task } from '@medplum/fhirtypes';

const task = await medplum.createResource<Task>({
  resourceType: 'Task',
  status: 'requested',                                  // requested → in-progress → completed/failed
  intent: 'order',
  focus: { reference: 'ClaimResponse/<id>' },           // or Encounter/ServiceRequest
  for: { reference: 'Patient/<id>' },
  description: 'Appeal: medical necessity',
  note: [{ text: 'Drafted by agent. Missing evidence: clinical indication documentation.' }],
});
```

**Task statuses:** `requested` → `in-progress` → `completed` / `failed`. Every agent step advances the Task — this gives the demo a visible progression and is the idempotency key.

#### Subscriptions — wake the right agent

```json
{
  "resourceType": "Subscription",
  "status": "active",
  "reason": "Wake agents on lifecycle events",
  "criteria": "ClaimResponse",
  "channel": { "type": "rest-hook", "endpoint": "<SERVER_URL>/hooks/claim-denied", "payload": "application/fhir+json" }
}
```

One Subscription per trigger (ClaimResponse, Encounter, ServiceRequest). All rest-hook to our server. The server's router decides which agent handles it:

- `ClaimResponse` → `isDenied()` → **Denial Appeal** agent
- `Encounter` (status finished) → **Discharge Coordinator** agent
- `ServiceRequest` (needs auth, no docs) → **Prior-Auth Docs** agent
- `Claim` (about to submit) → **Claim Triage** agent (invoked in-process by the appeal pipeline before submission)

**Webhook handler contract** (`/hooks/claim-denied`, `/hooks/encounter-discharged`, `/hooks/service-request`):
1. Read the resource from the payload
2. Check whether this agent should act (e.g., `isDenied()`, `status === 'finished'`)
3. **Idempotency:** if a `Task` already exists with `focus` = this resource, skip. Never double-process.
4. Kick off the pipeline async; return 200 fast.

---

### 5.2 The Agent Pipeline (THE MAIN BUILD)

One `pipeline.ts` orchestrates every agent. Each step is independently demonstrable on screen.

#### Pipeline

```
1. parseIntent(event)      → { agent, claimResponse?/encounter?/serviceRequest?, patient }
2. redact(intent)          → de-identified context (tokens replace PHI)     ← §5.6
3. retrieveContext(intent) → moss.query() + pubmed.search()                 ← §5.7
4. reasonAndAct(intent, context) → llm() → structured action { type, payload }
5. deRedact(action)        → re-inject PHI into the action payload          ← §5.6
6. execute(action)         → stedi / twilio / medplum writes
7. writeOutcome(task, result) → medplum Task update + ledger update
8. learn(result)           → memory: win-rate ledger + per-provider prefs   ← §5.8
```

Steps 2 and 5 are the **privacy layer** — nothing identifiable leaves the server except to Twilio/Stedi (the authorized PHI processors).

#### Agent handlers (function-handlers.ts)

**Denial Appeal handler:**
```typescript
// payload: ClaimResponse (denied)
async function denialAppeal({ claimResponse, patient }) {
  const denial = parseDenial(claimResponse);                    // reason mapping
  const criteria = await moss.retrieveCriteria(claim.procedure, payer);  // Moss
  const evidence = await pubmed.search(denial, claim.procedure);         // PubMed (§5.7)
  const appeal = await llm.draftAppeal({ denial, criteria, evidence });  // LLM (JSON)
  const result = await stedi.resubmitClaim(appeal.resubmitPayload); // Stedi / mock
  await medplum.updateTask(taskId, 'completed', result);
  await memory.recordAppealOutcome(denial.reason, result.approved);      // §5.8
}
```
The `evidence` array (title + PMID + citation + relevance) is attached to the Task as a `processNote` so the dashboard can show "Agent found 2 papers backing the appeal."

**Claim Triage handler (prevention — runs before submission):**
```typescript
// payload: Claim ready to submit
async function claimTriage({ claim, patient }) {
  const criteria = await moss.retrieveCriteria(claim.procedure, payer);
  const gaps = await llm.checkClaimAgainstCriteria({ claim, criteria });  // JSON
  if (gaps.length) {
    // fix what we can (e.g., attach prior-auth docs, correct codes)
    await medplum.updateClaim(claim.id, { status: 'active', ...fixes });
  }
  const result = await stedi.submitClaim(fixedClaim);
  await medplum.createTask({ description: 'Triage result', note: gaps });
}
```

**Discharge Coordinator handler (initiates the outbound call):**
```typescript
// payload: Encounter (status finished)
async function dischargeCoordinator({ encounter, patient }) {
  const task = await medplum.createTask({ status: 'requested', focus: encounter });
  const careGaps = await medplum.findOverdueServiceRequests(patient.id);  // care-gap detection
  await twilio.initiateCall({ to: patient.phone, from: TWILIO_NUMBER,
    url: `${TWILIO_WEBHOOK_BASE_URL}/twilio/outbound-voice` });
  await medplum.updateTask(task.id, 'in-progress', { note: 'Call initiated' });
}
```

**Care-Gap logic** (runs inside the discharge call): when the agent's `check_care_gaps` function fires, query Medplum for the patient's overdue `ServiceRequest`s (occurrenceDateTime < now, status active). Return them so the agent can offer to book.

**Prior-Auth Docs handler** (timeline element — build last): on `ServiceRequest` needing auth, look up the payer requirement (Moss), check what docs exist (FHIR `DocumentReference`), complete/create what's missing, submit via Stedi.

#### parseDenial (reason mapping)

```typescript
export type DenialReason = 'missing_documentation' | 'code_mismatch' | 'medical_necessity' | 'timely_filing' | 'other';

export function parseDenial(cr: ClaimResponse): { reason: DenialReason; rawText: string } {
  const text = (cr.disposition || '').toLowerCase();
  if (text.includes('documentation') || text.includes('records')) return { reason: 'missing_documentation', rawText: cr.disposition || '' };
  if (text.includes('necessity') || text.includes('not covered')) return { reason: 'medical_necessity', rawText: cr.disposition || '' };
  if (text.includes('code') || text.includes('billing')) return { reason: 'code_mismatch', rawText: cr.disposition || '' };
  if (text.includes('timely') || text.includes('late')) return { reason: 'timely_filing', rawText: cr.disposition || '' };
  return { reason: 'other', rawText: cr.disposition || '' };
}
```

#### LLM access

- `openai` SDK pointed at `LLM_BASE_URL`/`LLM_API_KEY` — works with OpenAI or any compatible endpoint.
- Every LLM call returns strict JSON (use `response_format: { type: 'json_object' }`); validate with a schema before using.
- **Mandatory template fallback** — if no key or call fails, return a deterministic template. The pipeline must never block on the LLM.

---

### 5.3 Stedi (X12 EDI) — THE REVENUE-CYCLE BACKBONE

**Docs:** https://www.stedi.com/docs/healthcare/test-mode

#### Eligibility — 270/271 (triage + discharge call)

```
POST https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3
Headers: Authorization: Key <STEDI_API_KEY>
         Content-Type: application/json
```

```json
{
  "tradingPartnerServiceId": "60054",
  "provider": { "organizationName": "Demo Provider", "npi": "1999999984" },
  "subscriber": { "firstName": "John", "lastName": "Doe", "memberId": "AETNA9wcSu" },
  "encounter": { "serviceTypeCodes": ["30"] }
}
```

**Test-mode rules:**
- `tradingPartnerServiceId` `60054` = Aetna test payer. Other mock payers: Cigna, UnitedHealthcare, CMS.
- Mock requests **must use exact subscriber values from the docs** — wrong names/member IDs error. Use documented demo member IDs (e.g. `AETNA9wcSu`). Do NOT invent them.
- **Medical** mock requests require service type code `30`. Code `35` is **dental-only**. Do NOT use `35` for a medical check.
- NPI `1999999984` is a known-good dummy.

**Response fields to surface:** `benefitsInformation[].benefitAmount` / `coPayAmount` / `coverageLevel` / `serviceTypeCode` / **`authOrCertIndicator`** (Y/N/U — the real prior-auth signal that anchors the mock denial).

#### Claims + Denials

**⚠️ KNOWN RISK — the denial is simulated, anchored to a real signal.** Two hard Stedi facts (verified against current docs):
1. **Free sandbox accounts = eligibility only.** Sandbox accounts cannot submit test claims through the API or SFTP — "You need a production account to access these features."
2. **Even real test claims always pay.** Test claims require upgrading to a production account (credit card, $100 minimum balance) and enrolling with the **Stedi Test Payer** (`STEDITEST`); the resulting test 835s *always* pay all lines: "Test 835 ERAs always indicate that all service lines are paid." Denials only occur with production claims.

**The honest + demonstrable pattern (default = free sandbox, no card):**
1. Run a **real** mock eligibility check (medical STC `30`) for the demo patient — free, works on sandbox.
2. Observe `authOrCertIndicator: Y` (prior auth required — real).
3. **Generate** the (clearly labeled) simulated `ClaimResponse` denial via the denial simulator (§5.3 "denial simulator") *because* prior auth was required but not provided — the denial is predicted from real data, not invented.
4. Appeal engine runs for real (parse → retrieve criteria → draft → resubmit).
5. Resubmission → simulator returns **paid** (mirrors test-mode's always-pay 835).

[OPTIONAL, $100 credit card] Upgrade to a production account to get a **real** test 277CA + test 835 for the resubmitted claim: enroll the dummy provider with the Stedi Test Payer (`STEDITEST`, auto-LIVE in ~1 min, dummy NPI `1999999984`), send the claim with `usageIndicator: "T"`. The 835 will pay — the real "recovered" signal. Only do this if you want the EDI round-trip on screen; it is not required for the demo.

Disclose in the pitch: "we predicted the denial from the eligibility signal; the denial payload itself is simulated, which Stedi's test mode mandates."

**Claim submission** (used by triage):
```
POST https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/professionalclaims/v3/raw-x12-submission
```
with `{ "x12": "<ISA*...*837*...>" }` → 277CA acknowledgment. **On a free sandbox this endpoint errors (claims need a production account) — the simulator handles submission.** On a production account, set `ISA15: T` (or `usageIndicator: "T"` on the JSON endpoint) so the claim is treated as test data.

**Appeal resubmission** — submit the corrected claim (replacement, CFC `7` on the 837). On the free sandbox the simulator returns **paid** — that's the "recovered" outcome. On production + Stedi Test Payer you get a real test 835 that pays. Always send an `Idempotency-Key` header on claims POSTs.

#### The denial simulator (`stedi-mock.ts`) — deterministic, production-shaped

Since Stedi's test mode structurally cannot deny, `stedi-mock.ts` is a **configurable denial simulator** that emulates a payer's adjudication engine. It is NOT a hardcoded fake — it derives the denial from the claim + a seeded config, so the same claim always produces the same denial (repeatable demo), but different claims produce different, realistic denials.

**Interface — swap-in compatible with the real client** (`stedi.ts` and `stedi-mock.ts` expose the same `StediClient` type, switched in `config.ts` via `STEDI_MODE=live|simulate`):

```typescript
export interface StediClient {
  eligibility(req: EligibilityRequest): Promise<EligibilityResponse>; // real, always
  submitClaim(claim: Claim): Promise<ClaimResponse>;                  // real in live; simulated denial in simulate
  resubmitClaim(payload: ResubmitPayload): Promise<ClaimResponse>;    // real 835 in live; "paid" in simulate
}
```

**Seed (deterministic):** denial is a pure function of the claim inputs — `denialFor(claim) = simulate(payer, procedure, missingAuth)`. Hash the inputs so re-runs and re-seeds are identical. No randomness, no wall-clock dependence. The demo must be byte-for-byte repeatable.

**Config (`simulation-config.ts`):**

```typescript
export interface DenialRule {
  procedure: string;                    // e.g. 'MRI'
  payer: string;                        // e.g. 'Blue Shield PPO'
  reason: DenialReason;                 // missing_documentation | code_mismatch | medical_necessity | timely_filing | other
  requiresAuth: boolean;                // if true and claim has no prior auth → deny with missing_documentation
  disposition: string;                  // exact payer text shown on the dashboard
  errorCode: string;                    // HL7 adjudication-error code, e.g. 'Missing'
  fixHint: string;                      // what the appeal must change to win (the "fix")
}

export const DENIAL_RULES: DenialRule[] = [
  { procedure: 'MRI', payer: 'Blue Shield PPO', reason: 'missing_documentation', requiresAuth: true,
    disposition: 'Denied: Prior authorization was not obtained for the requested service.',
    errorCode: 'Missing', fixHint: 'Attach prior authorization (obtained via Prior-Auth Docs agent) and resubmit.' },
  { procedure: 'CT', payer: 'Blue Shield PPO', reason: 'code_mismatch', requiresAuth: true,
    disposition: 'Denied: The procedure code submitted does not match the documented diagnosis.',
    errorCode: 'Invalid', fixHint: 'Correct the procedure code to match the diagnosis and resubmit.' },
  { procedure: 'MRI', payer: 'Cigna', reason: 'medical_necessity', requiresAuth: true,
    disposition: 'Denied: Medical necessity not established. Referral and 4 weeks of conservative therapy required.',
    errorCode: 'Missing', fixHint: 'Attach referral letter and 4 weeks of documented conservative therapy.' },
  { procedure: 'X-ray', payer: 'Blue Shield PPO', reason: 'other', requiresAuth: false,
    disposition: 'Denied: Claim submitted after the timely filing window.',
    errorCode: 'Duplicate', fixHint: 'Resubmit with timely-filing exception documentation.' },
];
```

**Simulation rules:**
1. Match `procedure` + `payer` → rule. No match → pay (test-mode behavior).
2. If `rule.requiresAuth` AND the claim carries no prior-auth evidence (no `Claim.related`, no auth `DocumentReference`, or real eligibility returned `authOrCertIndicator: Y` and no auth recorded) → deny `missing_documentation`. **This is how the real eligibility signal anchors the simulation.**
3. Otherwise deny with the rule's configured reason.
4. `resubmitClaim()` **always returns a paid response** for the corrected claim — that's the "recovered" outcome, mirroring test-mode's always-pay 835.

**Production-shaped payload** — the simulator emits a canonical FHIR `ClaimResponse` (not a stub) using the `buildDenialResponse()` helper in §5.1: `outcome: 'error'` + zeroed `benefit` adjudication + `disposition` + `processNote` + `error[].code`. It is exactly what a real payer denial would look like, so the pipeline, dashboard, and `isDenied()` treat it identically.

**CLI (`scripts/simulate-denial.ts`):** `npm run simulate -- --procedure MRI --payer "Blue Shield PPO" --with-auth` prints the generated `ClaimResponse` and the `fixHint`. Use it to iterate on the demo seed and to show the "predicted denial" in the pitch.

**Disclosure (keep in the pitch):** the loop — parse → retrieve criteria → draft → resubmit → track — is fully real. Only the denial *payload* is simulated because Stedi's test mode mandates always-pay. The simulation is anchored to a real eligibility signal (`authOrCertIndicator: Y`), so we are predicting, not inventing, the denial.

---

### 5.4 Moss (Real-Time Semantic Search) — THE CRITERIA BRAIN

**Docs:** https://docs.moss.dev

> **Why Moss matters:** Moss founder **Sri Raghu Malireddi is a hackathon judge**. The criteria-retrieval step (sub-10ms, drives both triage and appeal) is the perfect showcase. Do it well.

#### Indexes (create both)

```typescript
import { MossClient } from '@moss-dev/moss';

const client = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!);

// 1. Payer clinical criteria — drives triage + appeal
await client.createIndex('payer-criteria', [
  { id: 'bs-mri-brain', text: 'Blue Shield PPO MRI coverage criteria: (1) ICD-10 diagnosis code, (2) prior imaging notes or referral, (3) 6 weeks failed conservative therapy documented. Prior authorization required.', metadata: { payer: 'Blue Shield PPO', procedure: 'MRI', requiresAuth: true } },
  { id: 'bs-ct', text: 'Blue Shield PPO CT coverage criteria: (1) ICD-10 diagnosis code, (2) written order, (3) clinical indication documented. Prior authorization required for CT abdomen/pelvis.', metadata: { payer: 'Blue Shield PPO', procedure: 'CT', requiresAuth: true } },
  { id: 'bs-xray', text: 'Blue Shield PPO X-ray coverage: no prior authorization required for routine imaging. Documentation of indication required.', metadata: { payer: 'Blue Shield PPO', procedure: 'X-ray', requiresAuth: false } },
  { id: 'cigna-mri', text: 'Cigna MRI criteria: ICD-10 diagnosis, referral from treating physician, 4 weeks conservative therapy for musculoskeletal indications.', metadata: { payer: 'Cigna', procedure: 'MRI', requiresAuth: true } },
  { id: 'denial-reason-map', text: 'Common denial reasons: MISSING_DOCS = prior authorization paperwork absent. CODE_MISMATCH = procedure code does not match diagnosis. MED_NECESSITY = clinical indication not established.', metadata: { category: 'denial-reasons' } },
]);
await client.loadIndex('payer-criteria');

// 2. Care protocols — drives discharge + care-gap
await client.createIndex('care-protocols', [
  { id: 'post-op-chole', text: 'Post-operative cholecystectomy follow-up: call within 24h, monitor for fever, severe pain, jaundice, or vomiting. Follow-up appointment within 2 weeks. Escalate immediately if fever >101F or severe abdominal pain.', metadata: { procedure: 'cholecystectomy', redFlags: ['fever', 'severe pain', 'jaundice'] } },
  { id: 'mammogram-screening', text: 'Screening mammogram recommended every 2 years for women 40-49, annually for 50+. Overdue if more than 2 years since last screening.', metadata: { screening: 'mammogram', intervalYears: 2 } },
]);
await client.loadIndex('care-protocols');
```

**Queries:**
```typescript
const criteria = await client.query('payer-criteria', 'Blue Shield MRI brain coverage evidence required', { topK: 3 });
const protocol = await client.query('care-protocols', 'post op cholecystectomy follow up', { topK: 1 });
```

**Integration contract:**
- `loadIndex` each index **once at boot**. Query per request.
- `retrieveCriteria(procedure, payer)` → criteria doc text + metadata → feeds triage + appeal.
- `retrieveProtocol(procedure)` → care protocol → feeds the discharge call's red-flag checks.
- **Fallback:** static criteria map in code if Moss is down (pipeline never blocks).

---

### 5.5 The Outbound Discharge Call (Deepgram + Twilio)

**The flow (test this before demo day — riskiest live moment):**

1. **Initiate** — Discharge Coordinator handler calls Twilio REST:
   ```typescript
   import twilio from 'twilio';
   const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

   await client.calls.create({
     to: patientPhone,                          // +15551234567 (demo: use a number you control)
     from: TWILIO_PHONE_NUMBER,
     url: `${TWILIO_WEBHOOK_BASE_URL}/twilio/outbound-voice`,  // Twilio GETs this for TwiML
   });
   ```

2. **TwiML** — `/twilio/outbound-voice` returns `<Connect><Stream>` (keeps the call open for the whole call — do NOT use `<Start>` + `<Pause>`, that drops the call):
   ```xml
   <Response>
     <Connect>
       <Stream url="wss://<ngrok-url>/stream">
         <Parameter name="callSid" value="{callSid}" />
         <Parameter name="patientId" value="<medplum-patient-id>" />
       </Stream>
     </Connect>
   </Response>
   ```

3. **Audio bridge** — `/stream` WebSocket. Identical to inbound: Twilio sends base64 μ-law → forward to Deepgram (no transcode) → Deepgram `AgentV1Audio` (mulaw) → forward back. Track `streamSid` from the `start` event.

4. **Deepgram outbound session** — same endpoint `wss://agent.deepgram.com/v1/agent/converse`, same auth, different `Settings`:
   - `audio.input = { encoding: "mulaw", sample_rate: 8000 }`, `audio.output = { encoding: "mulaw", sample_rate: 8000, container: "none" }`
   - `agent.listen.provider.model = "flux-general-en"`, `agent.think.provider.model = "gpt-4o-mini"`, `agent.speak.provider.model = "aura-2-thalia-en"`
   - `agent.greeting` = the discharge opener (see prompt below)
   - Functions: `book_follow_up`, `escalate_to_clinic`, `check_care_gaps`, `verify_coverage`, `send_sms`, `end_call`

5. **Barge-in** — on user-started-speaking, send Twilio `{ "event": "clear", "streamSid": "<sid>" }`.

**Discharge agent prompt** (`voice/prompt.ts`):
```
You are Maya, a care coordinator calling to check in after surgery.
Rules:
1. Greet by name, reference the recent surgery (e.g. "checking in after your procedure").
2. Ask how they're feeling; if they report red-flag symptoms (fever over 101F, severe pain,
   jaundice, vomiting), call escalate_to_clinic immediately and be reassuring.
3. After the check-in, run check_care_gaps — if overdue screenings exist, offer to book one
   and call verify_coverage first.
4. When booking a follow-up, use the provider's saved preference (memory.getProviderPrefs):
   "Our records show your office books follow-ups at 14 days — shall I schedule that?"
5. Always say a filler like "Let me check that for you" before calling any function.
6. Confirm the appointment time with the patient before booking.
7. Never invent coverage facts — only repeat what verify_coverage returns.
```

**Function handlers (discharge call):**
- `book_follow_up` → create Medplum `Appointment` (status booked, using provider's preferred follow-up window from `memory.getProviderPrefs`)
- `escalate_to_clinic` → create Medplum `Task` (urgent) + Twilio SMS to clinic staff number
- `check_care_gaps` → query Medplum for patient's overdue `ServiceRequest`s → return list
- `verify_coverage` → Stedi 270/271 → return copay/active
- `send_sms` → Twilio SMS confirmation to the patient
- `end_call` → close both WebSockets gracefully

**Reference implementation to copy:** github.com/deepgram-devs/deepgram-voice-agent-inbound-telephony — read `voice_agent/agent_config.py` + `session.py` for the exact message flow; adapt the outbound trigger from Twilio's `calls.create` docs.

---

### 5.6 Privacy / PHI Redaction Layer — HIPAA story, visible in the demo

Every external call (LLM, Moss, PubMed) is a potential PHI leak. The redaction layer guarantees that **only de-identified data ever leaves the server** — Twilio and Stedi are the exceptions (they're the authorized processors who need real identity/PHI).

**Module `integrations/redact.ts`:**

```typescript
// Map FHIR PHI → tokens. Deterministic per session; stored in memory.
// Returns { redacted, map } where map lets you deRedact() later.
export function redact(input: { patient: Patient; text?: string }): { redacted: RedactedContext; map: RedactMap };
export function deRedact(action: unknown, map: RedactMap): unknown;

type RedactMap = { patientId: string; names: Record<string, string>; phone: string; dob: string; mrn: string };
```

**What gets redacted (all of it):**
- Patient `name` → `PATIENT_1`
- `mrn` / `id` → `MRN_1`
- `telecom` (phone/email) → `PHONE_1`
- `birthDate` → kept as `age` only
- Address, SSN, insurance member ID → `ID_1`

**Where it runs (wired into the pipeline, not optional):**
1. **Before** `moss.query()`, `pubmed.search()`, and `llm()` — replace with tokens.
2. **After** the LLM returns a structured action — `deRedact()` swaps tokens back before the action hits Stedi/Medplum/Twilio.
3. The discharge call's `verify_coverage` is the only path that intentionally sends real subscriber PHI (memberId + DOB) to Stedi — it is a permitted processor and the call already runs inside the pipeline. Everything else (PubMed/Moss/LLM) never sees it.

**Demo beat:** the dashboard shows a `redacted` count per step — e.g. "Appeal draft sent to LLM with 7 PHI tokens redacted." This is the HIPAA-compliance talking point.

**Fallback:** redaction is synchronous pure functions — no failure mode. If `deRedact` ever can't map a token back, the action is rejected (fail closed), never sent half-redacted.

---

### 5.7 PubMed Medical-Evidence Grounding — the appeal's "receipt"

The appeal is stronger when it cites real medical literature. PubMed E-utilities is **free, no API key, no auth** — a pure HTTP fetch. This is a sponsor-adjacent integration that makes the centerpiece demo beat concrete: the agent doesn't just resubmit, it attaches evidence.

**Search (`integrations/pubmed.ts`):**

```typescript
// ESearch → returns PMIDs; EFetch/esummary → returns titles/abstracts.
async function searchEvidence(denial: DenialReason, procedure: string): Promise<Evidence[]> {
  // term e.g. "MRI[tiab] AND (medical necessity OR prior authorization) AND systematic review[pt]"
  const esearch = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=3&retmode=json`);
  const { esearchresult } = await esearch.json();
  // ... esummary for titles + citations
}

export interface Evidence {
  title: string;
  pmid: string;
  citation: string;   // e.g. "J Med Imaging. 2024;11(3):034501"
  relevance: string;  // 1-line why it supports the appeal
}
```

**Rules:**
- Query is built from the **de-identified** context only: procedure + denial reason + payer. No patient name/DOB/MRN ever enters the term.
- Only surfaced in the **Denial Appeal** agent (the money centerpiece). Other agents don't need it.
- Results are appended to the Task `processNote` (title + PMID + citation). The dashboard renders them as the "evidence attached to the appeal."
- **Rate limits:** E-utilities allows 3 req/s without a key; keep the appeal path to ≤ 2 calls (1 ESearch + 1 esummary), and memoize per (reason, procedure).
- **Fallback:** if PubMed is unreachable, the appeal still drafts with criteria-only and the Task notes "evidence lookup unavailable." Pipeline never blocks.

**Terms to try (seed these during Phase 1):**
- Medical necessity: `"medical necessity[tiab] AND (prior authorization OR preauthorization) AND MRI"`
- Missing documentation: `"prior authorization[tiab] AND imaging[tiab] AND denial"`
- Code mismatch: `"procedure code[tiab] AND denial[tiab] AND documentation"`

---

### 5.8 Memory Layer — learning ledger + per-provider preferences

Two kinds of memory, both lightweight and demo-visible. No new infra — JSON file(s) or Medplum `Task` notes (same rule as §3: no databases).

**A. The learning ledger (already in the plan, now the "self-improving" story):**
- `memory.recordAppealOutcome(reason, approved)` → increments a win-rate counter per denial reason.
- `memory.prioritizeAppeals()` → sorts pending appeals by expected value (winRate × claimAmount).
- Dashboard table: win rate by denial reason, updated live after each run.

**B. Per-provider preferences (the "learns user's preferences" story):**
```typescript
export interface ProviderPreferences {
  providerId: string;
  followUpDays: number;            // e.g. 14
  followUpBookingWindow: string;   // e.g. '09:00-17:00'
  smsOnBooking: boolean;
  escalationChannel: string;       // phone | sms | page
  learnedFrom: string[];           // free-text notes of observed behavior
}
```
- Stored as a Medplum `Task`/`Observation` resource or JSON file keyed by provider.
- The **Discharge Coordinator** reads it when booking the follow-up (e.g. "Dr. Li prefers 14-day follow-ups + SMS confirmation"). The voice agent prompts confirm the preference out loud: *"Our records show your office books follow-ups at 14 days — shall I schedule that?"* — that's the "learned your preference" demo line.
- `memory.ts` exports `getProviderPrefs(providerId)` and `updatePrefs(providerId, patch)`; preferences are seeded in `scripts/seed-medplum.ts` so the demo starts with one known preference.
- **Fallback:** defaults if no prefs found (14 days, sms on, escalation=phone). Never blocks.

---

## 6. Build Phases (follow in order)

### Phase 0 — Foundation + signal verification (2 hrs)
- [ ] Create accounts: Deepgram ($200 credits), Medplum, Stedi (sandbox = free, test mode, no card; production upgrade $100 credit card is [OPTIONAL] for real test 835s), Moss (hackathon access), Twilio.
- [ ] Scaffold repo: `npm init`, install deps (`fastify`, `@fastify/websocket`, `@medplum/core`, `@medplum/fhirtypes`, `@moss-dev/moss`, `openai`, `twilio`, `dotenv`, `tsx`).
- [ ] Write `.env` (see §4) + `.gitignore` (`.env`, `node_modules`, `dist`, `graphify-out/`).
- [ ] **CRITICAL: verify the real signal.** Run a real mock eligibility check (medical STC `30`) → confirm `authOrCertIndicator: Y` for the demo payer. This anchors the simulated denial.
- [ ] Verify Medplum: `startClientLogin()` + create a throwaway `Patient`.
- [ ] Verify Moss: `createIndex` + `loadIndex` + `query`.
- [ ] Verify LLM key: one completion call.
- [ ] Set up ngrok/`cloudflared` tunnel (needed for Twilio webhooks + Media Streams).

**Definition of done:** all APIs respond, the tunnel works, the repo builds (`tsc --noEmit`).

### Phase 1 — The appeal pipeline (money centerpiece) (4 hrs)
- [ ] Medplum integration: `createClaim()`, `createClaimResponse()` (canonical denial), `createTask()`, `updateTask()`, `findTaskByFocus()`.
- [ ] `parseDenial()` mapping (§5.2).
- [ ] **Redaction layer (§5.6):** `redact()`/`deRedact()` wired around Moss, PubMed, and LLM calls; fail-closed on unmapped tokens.
- [ ] **PubMed evidence (§5.7):** `pubmed.searchEvidence(reason, procedure)` → Evidence[]; appended to Task `processNote`. Seed the 3 example terms.
- [ ] `Subscription` for `ClaimResponse` → `/hooks/claim-denied`; handler with `isDenied()` + idempotency.
- [ ] Pipeline steps: redact → retrieve criteria (Moss) + evidence (PubMed) → draft appeal (LLM + template fallback) → de-redact → resubmit (Stedi/denial simulator) → write outcome.
- [ ] Build `stedi-mock.ts` denial simulator + `DENIAL_RULES`; wire `STEDI_MODE=simulate` in `config.ts`.
- [ ] Seed: demo Patient + Coverage + denied ClaimResponse (via `scripts/simulate-denial.ts`).

**Definition of done:** creating a denied `ClaimResponse` auto-creates a Task, retrieves criteria + PubMed evidence, drafts (de-identified), resubmits, and completes the Task with an APPROVED result + evidence notes. Verified via CLI + Medplum console.

### Phase 2 — Claim Triage (prevention) (2 hrs)
- [ ] Triage handler: criteria (Moss) → gap check (LLM) → fix what's fixable → submit (Stedi) → Task.
- [ ] Wire triage to run before claim submission in the pipeline.
- [ ] Seed a claim with a real gap (e.g., missing prior-auth paperwork) to show prevention.

**Definition of done:** submitting a "gappy" claim shows the agent catching and fixing the gap before the clean submission, and the demo screen can show both.

### Phase 3 — Memory + dashboard (2 hrs)
- [ ] `memory.ts`: win-rate ledger per denial reason + per-provider preferences (`ProviderPreferences`, §5.8); every outcome increments.
- [ ] `prioritizeAppeals()` — sort pending by expected value (winRate × claimAmount).
- [ ] Dashboard page (`/dashboard`): shows the demo claim's journey (triage → denied → appeal → approved), the **evidence attached to the appeal (PubMed titles + PMIDs)**, the discharge call status, the win-rate table, and a redaction counter per step.

**Definition of done:** the dashboard shows the full money path, the evidence backing the appeal, and the learning table + provider prefs updating after each run.

### Phase 4 — Outbound discharge call + care-gap (5 hrs) ← highest risk
- [ ] Twilio `calls.create` → `/twilio/outbound-voice` TwiML (`<Connect><Stream>`) → `/stream` bridge (μ-law passthrough).
- [ ] Deepgram outbound Settings: discharge prompt + functions (`book_follow_up`, `escalate_to_clinic`, `check_care_gaps`, `verify_coverage`, `send_sms`, `end_call`).
- [ ] `Encounter` Subscription → `/hooks/encounter-discharged` → Discharge Coordinator handler → initiates the call.
- [ ] Care-gap: `findOverdueServiceRequests()` + `check_care_gaps` function wired to it.
- [ ] **Local dev first:** write `dev-client.ts` (browser mic → `/stream`) to test the conversation loop without Twilio. Only after it works locally, test the real outbound call. Call a number you control.
- [ ] SMS on booking + escalation path.

**Definition of done:** you receive a real outbound call that checks in, detects red flags or care gaps, books a follow-up + the overdue mammogram, and confirms coverage — all writing back to FHIR.

### Phase 5 — Prior-auth docs agent (timeline element) (1.5 hrs)
- [ ] `ServiceRequest` Subscription → handler: criteria (Moss) → check existing `DocumentReference`s → create missing doc → submit (Stedi/mock) → Task.
- [ ] Show it as a timeline item on the dashboard.

**Definition of done:** a ServiceRequest needing auth produces a completed Task on the dashboard.

### Phase 6 — Demo hardening (2 hrs)
- [ ] Seed ONE locked demo path: Patient Jane Doe (Blue Shield PPO, MRI claim, surgery Encounter, overdue mammogram).
- [ ] Pre-record fallback demo video (money loop + a recorded call) in case live fails.
- [ ] Every external call wrapped in try/catch with a graceful fallback — the pipeline never crashes.
- [ ] Rehearse the 3-minute script (see `yc-medplum-hackathon-plan.md` §Demo Script) at least 5× with someone who hasn't seen it.

**Definition of done:** the exact demo runs back-to-back 5 times: triage catches gap → denial → appeal wins → live discharge call closes a care gap → dashboard updates.

---

## 7. Repository Layout

```
yc-medplum-hackathon/
├── AGENTS.md                  ← this file
├── package.json
├── tsconfig.json
├── .env                       ← git-ignored
├── .env.example
├── .gitignore
├── src/
│   ├── server.ts              ← Fastify app: /hooks/*, /twilio/*, /stream, /dashboard, /health
│   ├── config.ts              ← typed env access (fail fast on missing vars)
│   ├── integrations/
│   │   ├── medplum.ts         ← Claim/ClaimResponse/Task/Encounter/ServiceRequest CRUD
│   │   ├── stedi.ts           ← eligibility + claims (real; STEDI_MODE=live)
│   │   ├── stedi-mock.ts      ← denial simulator (deterministic, seeded; STEDI_MODE=simulate)
│   │   ├── simulation-config.ts ← DENIAL_RULES table (procedure × payer → reason)
│   │   ├── moss.ts            ← payer-criteria + care-protocols indexes
│   │   ├── pubmed.ts          ← E-utilities evidence search (free, no key)
│   │   ├── redact.ts          ← PHI → tokens; deRedact (privacy layer)
│   │   ├── llm.ts             ← openai client + strict-JSON helpers + template fallback
│   │   └── twilio.ts          ← calls.create + SMS + Media Streams helpers
│   ├── agents/
│   │   ├── router.ts          ← maps FHIR event → agent handler
│   │   ├── pipeline.ts        ← shared: parse → redact → context → reason → de-redact → act → write → learn
│   │   ├── claim-triage.ts
│   │   ├── denial-appeal.ts
│   │   ├── discharge-coordinator.ts
│   │   ├── care-gap.ts
│   │   ├── prior-auth-docs.ts
│   │   ├── parse-denial.ts
│   │   └── memory.ts          ← win-rate ledger + per-provider preferences (§5.8)
│   ├── voice/                 ← outbound discharge call
│   │   ├── agent-settings.ts  ← Deepgram Settings (discharge prompt + functions)
│   │   ├── stream-proxy.ts    ← Twilio ↔ Deepgram WS bridge (μ-law passthrough)
│   │   ├── function-handlers.ts ← call functions → integrations
│   │   └── prompt.ts          ← discharge agent system prompt
│   ├── dev/
│   │   └── dev-client.ts      ← local mic/speaker client (no Twilio needed)
│   └── scripts/
│       ├── seed-medplum.ts    ← demo Patient/Coverage/Claim/Encounter/ServiceRequest
│       ├── seed-moss.ts       ← payer-criteria + care-protocols indexes
│       ├── run-appeal.ts      ← CLI: run pipeline on a seeded claim
│       ├── simulate-denial.ts ← CLI: print a simulated ClaimResponse for a claim
│       └── test-integrations.ts
└── docs/
    ├── demo-notes.md
    └── ledger-schema.md
```

---

## 8. Coding Conventions

- **TypeScript strict mode.** No `any` except at the boundary of untyped sponsor SDKs.
- **No comments unless they explain a non-obvious gotcha** (e.g. the μ-law passthrough, the anchored mock denial, the `isDenied()` FHIR representation, outbound vs inbound call flow).
- All credentials from `config.ts`, never inline.
- **Privacy is a hard rule: no PHI to LLM, Moss, or PubMed — always through `redact()`/`deRedact()` (§5.6).** Twilio/Stedi are the only permitted PHI receivers.
- Every external call wrapped in try/catch with a **graceful fallback** — the pipeline completes even if LLM/Moss/Stedi/PubMed is down (template appeal, cached criteria, evidence=[] , mock outcomes).
- **The pipeline is idempotent** — never process the same resource twice (Task-by-focus check).
- Use `fetch` for Stedi. Official SDKs for Medplum, Moss, Twilio, openai.
- `Task.status` is the source of truth for every agent's progress — update at every step.

---

## 9. Testing Strategy

- `npm run typecheck` — `tsc --noEmit` after every change.
- `npm run test:integrations` — live smoke: Stedi eligibility returns `authOrCertIndicator`, Moss criteria + protocol queries return docs, Medplum claim/task CRUD, LLM draft returns JSON.
- `npm run test:agents` — deterministic with mocks: seed a denied claim → assert Task goes requested → in-progress → completed with APPROVED + evidence notes; triage fixes a gap; ledger increments; provider prefs applied on booking; idempotency holds on re-run.
- `npm run test:simulator` — denial simulator determinism: same claim twice → identical `ClaimResponse`; `requiresAuth` rule denies a claim with no auth but pays one with auth; `resubmitClaim()` always returns paid.
- `npm run test:privacy` — redaction round-trip: `deRedact(redact(foo))` reconstructs PHI exactly; no real name/DOB/MRN appears in any LLM/Moss/PubMed payload; fail-closed on an unknown token.
- Manual QA:
  1. Denied ClaimResponse → Task created → criteria + PubMed evidence attached → appeal → completed.
  2. Triage fixes a gap before submission.
  3. Dashboard shows journey, evidence, win-rate, redaction counter.
  4. Outbound call: books follow-up (provider prefs honored), closes care gap, escalates on red flag.
  5. Re-run same event → no duplicate Task.
- Never commit `.env`. Keep `.env.example` current.

---

## 10. Known Risks & Mitigations

| # | Risk | Mitigation |
|---|------|------------|
| 1 | **Stedi test mode can't produce a real denial** (835s always pay; denials only with production) | **Deterministic denial simulator** (`stedi-mock.ts` + `DENIAL_RULES`): production-shaped, seeded by claim, anchored to real `authOrCertIndicator: Y`; disclose in the pitch. The loop is the novelty. |
| 2 | **Outbound call fails live** | Pre-test Twilio→Deepgram bridge before demo day; pre-recorded fallback clip. The money loop is the primary centerpiece. |
| 3 | **LLM down / weak output** | Template fallback mandatory; pipeline never blocks on LLM. |
| 3b | **PubMed rate-limit / down** | ≤2 E-utilities calls per appeal + memoization; evidence=[] fallback — appeal still drafts with criteria only. |
| 3c | **PHI leak to LLM/Moss/PubMed** | Redaction layer is a hard pipeline step (§5.6), fail-closed on unmapped tokens; `test:privacy` enforces it. |
| 4 | **Moss index not loaded → slow lookup** | `loadIndex` once at boot; cache; static fallback map. |
| 5 | **Duplicate processing of an event** | Idempotency: Task-by-focus check. |
| 6 | **Voice agent goes off-script on stage** | Tight prompt + hardcoded demo path; money loop is primary. |
| 7 | **Demo complexity (5 agents)** | Lock ONE seeded patient path; only 2 run live, 3 on timeline. |
| 8 | **Crowded receptionist space** | We're not in it — pitch leads with the back office. |
| 9 | **`<Start><Stream>` + `<Pause>` drops call** | Use `<Connect><Stream>`. |
| 10 | **Unverified flags (Aetna member ID, Moss import, Deepgram greet key)** | 2-minute Phase 0 checks: paste `AETNA9wcSu` in Stedi tester; confirm `@moss-dev/moss` import; confirm Settings key against Deepgram SDK. |
| 11 | **Credits run out** | Deepgram $200 is ample; LLM is cents per call. |

---

## 11. References

- Medplum FHIR: https://www.medplum.com/docs/fhir-datastore
- Medplum Bots/Subscriptions: https://www.medplum.com/docs/bots
- Stedi test mode: https://www.stedi.com/docs/healthcare/test-mode
- Stedi eligibility API: https://www.stedi.com/docs/healthcare/api-reference
- Moss: https://docs.moss.dev
- PubMed E-utilities: https://www.ncbi.nlm.nih.gov/books/NBK25501/
- Deepgram Voice Agent: https://developers.deepgram.com/docs/voice-agent
- Deepgram inbound telephony (reference impl): https://github.com/deepgram-devs/deepgram-voice-agent-inbound-telephony
- Twilio Media Streams: https://www.twilio.com/docs/voice/twiml/stream
- Twilio outbound calls (calls.create): https://www.twilio.com/docs/voice/make-calls
- Project plan: `./yc-medplum-hackathon-plan.md`
