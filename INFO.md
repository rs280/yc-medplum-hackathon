# INFO.md — Session Context (for future sessions)

Purpose: bring a future coding session up to speed on the YC x Medplum Hackathon project without re-reading everything. The authoritative build spec is `AGENTS.md`; this file records context, decisions, and current state.

## Project

- **Event:** YC x Medplum Hackathon, Aug 1 2026, YC SF (24h)
- **Product:** "The autonomous back office" — five FHIR-triggered AI agents on ONE shared pipeline that run the revenue cycle and patient care autonomously.
- **One-liner:** Five FHIR-triggered agents that prevent denials, win appeals, and call patients to coordinate care.

### The five agents (one engine, five handlers)

| Agent | Trigger | Does |
|-------|---------|------|
| Claim Triage (prevention) | `Claim` ready to submit | Checks vs payer criteria (Moss), fixes gaps pre-submission, submits clean |
| Prior-Auth Docs | `ServiceRequest` needs auth | Completes missing docs, submits via Stedi |
| Denial Appeal (cure) | `ClaimResponse` denied | Parses reason, retrieves criteria (Moss) + PubMed evidence, drafts appeal (LLM), resubmits, tracks win rate |
| Discharge Coordinator | `Encounter` finished | Calls patient within 24h, catches red flags, books follow-up |
| Care-Gap Agent | Overdue preventive care | Finds gap, calls patient, books + verifies coverage — runs inside discharge call |

### The unifying pipeline (THE core architecture)
```
FHIR event → agent handler → REDACT PHI → retrieve context (Moss + PubMed) → reason (LLM) → de-redact → act (Stedi/Twilio/Medplum) → write outcome → learn (memory)
```
One Node worker, one event router, five handler configs. Each agent advances a `Task` (requested → in-progress → completed/failed) and updates the memory ledger. Task-by-focus = idempotency key.

### Demo scope (locked)
- **Live:** triage catches + fixes gap; denial → appeal → APPROVED (centerpiece); live outbound discharge call that closes a care gap
- **Timeline only (dashboard):** prior-auth docs agent
- **On screen:** win-rate learning dashboard
- Non-goals: no real EHR, no production BAA (fake PHI only), no UI beyond dashboard

## Key decisions (all researched/verified this session)

1. **Denial is simulated, anchored to a real signal.** Stedi test mode can't deny:
   - Free **sandbox** accounts = **eligibility only** — cannot submit claims via API/SFTP.
   - Test **claims** require a production account (credit card, $100 min) + enrollment with **Stedi Test Payer** (`STEDITEST`, auto-LIVE ~1 min, dummy NPI `1999999984`, `usageIndicator: "T"`).
   - **Even real test 835s always pay all lines** ("Test 835 ERAs always indicate that all service lines are paid").
   - So: `stedi-mock.ts` is a **deterministic denial simulator** (seeded by claim, `DENIAL_RULES` table in `simulation-config.ts`, anchored to real `authOrCertIndicator: Y` from eligibility). Pipeline/dashboard treat its output as a real `ClaimResponse`.
   - Disclose in pitch: "we predicted the denial from the eligibility signal; the denial payload itself is simulated, which Stedi's test mode mandates."

2. **PHI redaction layer (added from teammate idea).** Every external call (LLM, Moss, PubMed) sees de-identified data only — `redact()`/`deRedact()` in `integrations/redact.ts`, wired as hard pipeline steps. Twilio + Stedi are the only permitted PHI receivers (authorized processors). Fail-closed on unmapped tokens. Dashboard shows a redaction counter per step.

3. **PubMed grounding (added).** Appeal agent retrieves real medical literature via PubMed E-utilities (free, no key, plain fetch). Evidence (title/PMID/citation) appended to Task `processNote` → "agent attached an RCT and won the appeal." ≤2 calls per appeal (ESearch + esummary), memoized; evidence=[] fallback.

4. **Memory layer (added).** `agents/memory.ts` = win-rate ledger per denial reason (self-improving story) + per-provider preferences (`ProviderPreferences`). Discharge call reads provider prefs and voices them ("Dr. Li prefers 14-day follow-ups"). Seeded in `scripts/seed-medplum.ts`.

5. **OpenRouter/model routing: SKIPPED** (teammate idea, not needed) — LLM is env-configurable already via `LLM_BASE_URL`.

6. **FHIR correctness gotchas (verified):**
   - `ClaimResponse.outcome` valid = `queued|complete|error|partial` (NO "denied"); adjudication code system has no "denied" code.
   - Canonical denial = `outcome:'error'` + zeroed `benefit` adjudication + `disposition` + `error[].code`; detect via `isDenied()` helper.
   - `Encounter.class` is a CodeableConcept.

7. **Voice/telephony gotchas (verified):**
   - TwiML must use `<Connect><Stream>` — NOT `<Start>`+`<Pause>` (drops call at 60s).
   - No audio transcode: pass μ-law straight through (8kHz).
   - Deepgram: `flux-general-en` STT, `gpt-4o-mini` think, `aura-2-thalia-en` speak; functions live in `agent.think.functions`.
   - Outbound = `twilio.calls.create({ to, from, url })` → Twilio GETs url for TwiML → `/stream` WS (same bridge as inbound).
   - Reference impl: `deepgram-devs/deepgram-voice-agent-inbound-telephony`.

8. **Stedi test-mode rules:** exact subscriber values required (`AETNA9wcSu`); medical = STC `30` (NOT `35`, that's dental); NPI `1999999984`; payer service id `60054` = Aetna.

9. **Moss:** YC F25; founder **Sri Raghu Malireddi is a hackathon judge** — the criteria-retrieval step is a showcase. Indexes: `payer-criteria` + `care-protocols`; `loadIndex` once at boot; static fallback map.

## Tech stack
TypeScript strict / Node ≥20 / Fastify (+WS) / Medplum FHIR R4 (the DB + task queue) / Stedi (fetch) / Moss (`@moss-dev/moss`) / PubMed E-utilities (fetch, no key) / `gpt-4o-mini` via openai SDK (template fallback mandatory) / Deepgram Voice Agent / Twilio Media Streams. **No** DBs/queues/brokers added.

## Env vars
`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `STEDI_API_KEY`, `STEDI_TRADING_PARTNER_ID=60054`, `STEDI_MODE=simulate`, `MEDPLUM_*`, `MOSS_*`, `DEEPGRAM_API_KEY`, `TWILIO_*`, `TWILIO_WEBHOOK_BASE_URL` (ngrok), `PORT=3000`.

## Repo layout
- `AGENTS.md` — authoritative build spec (sections: overview, architecture, stack, env, sponsor APIs 5.1–5.8, build phases 0–6, layout, conventions, testing, risks, references)
- `yc-medplum-hackathon-plan.md` — pitch, demo script, competitor table, unit economics, risk table
- `.gitignore` — node_modules, dist, .env*, graphify-out, .DS_Store, *.log
- Planned `src/`: `server.ts`, `config.ts`, `integrations/` (medplum, stedi, stedi-mock, simulation-config, moss, pubmed, redact, llm, twilio), `agents/` (router, pipeline, 5 handlers, parse-denial, memory), `voice/` (agent-settings, stream-proxy, function-handlers, prompt), `dev/dev-client.ts`, `scripts/` (seed-medplum, seed-moss, run-appeal, simulate-denial, test-integrations)

## Build phases (in order — never skip Phase 0)
- **0 Foundation + signal verification (2h):** accounts (Stedi sandbox free; production $100 = optional), scaffold, `.env`, **verify real eligibility returns `authOrCertIndicator: Y`**, verify Medplum/Moss/LLM, ngrok tunnel
- **1 Appeal pipeline (4h):** medplum CRUD, parseDenial, redaction + PubMed + LLM draft, simulator, seed
- **2 Claim triage (2h):** criteria → gap check → fix → submit
- **3 Memory + dashboard (2h):** ledger + provider prefs, prioritizeAppeals, dashboard with evidence + redaction counter
- **4 Outbound discharge call (5h):** highest risk — TwiML `<Connect><Stream>`, μ-law bridge, Deepgram settings, care-gap, local dev-client first, SMS
- **5 Prior-auth docs (1.5h):** timeline element
- **6 Demo hardening (2h):** one locked Jane Doe path, pre-recorded fallback, graceful fallbacks, rehearse 5×

## Testing
`typecheck`, `test:integrations`, `test:agents`, `test:simulator`, `test:privacy` (redaction round-trip, no PHI leaks, fail-closed).

## Risks (top)
1. Stedi can't deny → deterministic simulator + disclosure
2. Outbound call fails live → pre-test, recorded fallback, money loop primary
3. PHI leak → redaction hard rule + test:privacy
4. PubMed down/rate-limit → ≤2 calls, memoize, evidence=[]
5. Duplicate events → Task-by-focus idempotency
6. Voice off-script → tight prompt, locked demo path

## Current state (Aug 1 — BUILT, end-to-end verified)

The app is built under `app/` on a revised spec that supersedes parts of AGENTS.md:
**Next.js App Router** (not Fastify), **four** intents on ONE `runPipeline()`
(discharge + care-gap merged), **Anthropic API** (`claude-opus-5`, structured JSON
output) instead of openai, and the **memory layer lives in FHIR** (`Basic`
resources) with playbook lessons re-indexed into Moss after every resolved appeal.

- Pipeline (7 steps, one code path, branching only in parse-intent + act):
  parse intent → redact PHI (typed tokens + per-run surrogate map; `Redacted<string>`
  brand makes raw-PHI calls to Moss/PubMed/LLM a **compile error**) → retrieve
  (Moss all intents; PubMed appeal-only, real PMIDs enforced by a citation
  validator that drops invented citations) → reason (Claude or deterministic
  template fallback) → de-redact (fail-closed) → Task + Communication + AuditEvent
  + Stedi/Twilio dispatch → episodic memory + playbook aggregate + Moss re-index.
- Every integration degrades gracefully: no Medplum creds → file-backed store
  (`app/.data/`), no Moss key → lexical fallback over the same corpus, no
  Anthropic key → template letters, Stedi/Twilio → simulated (labeled) acks.
- Verified live: denial → appeal citing real PMIDs → approval → playbook WON →
  second denial retrieves `learned-CO-197` and reuses the winning argument;
  triage/discharge (care gap closed + SMS)/prior-auth all run; dashboard shows
  win rate by denial reason, PHI redaction counter, memory ledger.
- Run it: `cd app && npm install && npm run seed && npm run index-moss &&
  npm run dev` then `npm run demo -- deny|approve|triage|discharge|prior-auth`.
  If port 3000 is taken, `PORT=3100 npm run dev` and prefix demo commands with
  `APP_URL=http://localhost:3100`. Real services: fill `app/.env` from
  `.env.example`; with Medplum creds also run `npm run subscriptions`
  (needs public WEBHOOK_BASE_URL).
- Team: user + teammate. Voice: `app/src/app/api/voice/route.ts` is a thin
  Deepgram transcript receiver — the Twilio/Deepgram audio bridge (AGENTS.md §5.5)
  is still the teammate's open workstream.

## Files
- `app/` — the application (see `app/scripts/` for seed/subscriptions/index-moss/demo)
- `AGENTS.md` — original build spec (superseded where it conflicts with the above)
- `yc-medplum-hackathon-plan.md` — pitch + demo script + plan
- `INFO.md` — this file
