# YC x Medplum Hackathon — Project Plan

**Project:** The autonomous back office — AI agents that run the revenue cycle AND coordinate patient care  
**Event:** YC x Medplum Hackathon, August 1, 2026  
**Theme:** Agentic Healthcare — Doctor's Office of the Future  
**Prize Target:** 1st Place → YC Interview

---

## The Product

An agent platform for the doctor's office. Five autonomous AI agents watch the FHIR event stream and work problems end-to-end — preventing denials before they happen, fighting them when they don't, completing prior-auth documentation, and calling patients to coordinate their care. One engine, five workers.

**The pitch in one line:** *The front desk, billing, and care-coordination staff of a clinic — replaced by five FHIR-triggered agents that get smarter with every claim and every call.*

### The Five Agents (one engine, five handlers)

| Agent | Trigger (FHIR event) | What it does autonomously |
|-------|----------------------|---------------------------|
| **Claim Triage** (prevention) | `Claim` ready to submit | Checks the claim against payer clinical criteria (Moss), fixes gaps pre-submission, submits clean |
| **Prior-Auth Docs** | `ServiceRequest` needs authorization | Completes missing documentation, submits via Stedi |
| **Denial Appeal** (cure) | `ClaimResponse` denied | Retrieves payer criteria (Moss), drafts appeal with missing evidence (LLM), resubmits, tracks win rate |
| **Discharge Coordinator** | `Encounter` discharged | Calls the patient within 24h, catches red flags, books follow-up |
| **Care-Gap Agent** | Patient overdue for preventive care | Finds the gap, calls the patient, books + verifies coverage — can run inside the discharge call |

**The unifying pattern:** `FHIR event → agent handler → retrieve context (Moss) → reason (LLM) → act (Stedi / Twilio / Medplum) → write outcome → learn`. Same engine, different handler configs. This is the "AI as operating system" thesis — not one tool, a workforce.

### The Core Loop (the demo centerpiece — prevention + cure)

1. **Claim submitted** → the **Claim Triage agent** checks it against payer criteria (Moss) → catches a gap (e.g., missing prior-auth paperwork) → fixes it → submits clean. **Prevention.**
2. **Claim comes back denied anyway** (different reason — e.g., medical necessity) → the **Denial Appeal agent** parses why → retrieves the payer's clinical criteria → drafts the appeal with the missing evidence → resubmits → **APPROVED**. **Cure.**
3. Every outcome updates a **win-rate ledger per denial reason** — the agent learns which appeals are winnable and prioritizes accordingly. **Learning.**

### The Discharge Call (the emotional peak — live outbound)

1. Patient discharged after surgery → **Discharge Coordinator agent** calls within 24h
2. Agent checks in: *"How are you feeling? Any pain, fever, or concerns?"*
3. Same call, the **Care-Gap agent** chimes in: *"I also noticed you're overdue for your mammogram — want me to book that? I've verified it's covered."*
4. Red flag detected? → agent escalates to clinic staff via FHIR Task + SMS
5. Follow-up booked, gap closed, all written back to FHIR

**Two live moments, one narrative arc:** *prevent the denial → win the appeal → call the patient → close the gap.* Judges remember stories, not tool demos.

### Demo Scope (locked)

| Moment | Live? | Why |
|--------|-------|-----|
| Claim triage catches + fixes gap (prevention) | ✅ Live | The "wow, it works before we even submit" moment |
| Denial lands → agent fights → APPROVED (cure) | ✅ Live | The centerpiece |
| Discharge call (outbound) | ✅ Live | The emotional peak — a real phone call |
| Care-gap surfaced + booked in same call | ✅ Live | The "one call, two jobs" moment |
| Prior-auth docs agent | 🟡 Timeline | Same engine, shown on dashboard |
| Win-rate learning dashboard | ✅ On screen | "It gets smarter" closer |

---

## Sponsor APIs & What to Use

### Stedi (Healthcare Billing APIs) — THE REVENUE-CYCLE BACKBONE
- **Cost:** Free sandbox + test mode (no credit card) — mock eligibility only; test claims need a $100 production upgrade (optional)
- **What to build with it:**
  - `Eligibility API` — live 270/271 mock check (triage + discharge call) — free, sandbox
  - `Claims API` — claim submission (triage) — requires production upgrade for real test claims; sandbox uses the denial simulator
  - `Raw X12` — resubmission (appeal) — same constraint
  - **The agent's operating surface for anything money-related**
- **Known limit:** sandbox = eligibility only; test-mode 835s always pay; denials only occur with production claims. **The denial payload is simulated but anchored to a real signal** (`authOrCertIndicator: Y` from eligibility). The loop is real; only the denial payload is simulated.
- **Key docs:** https://www.stedi.com/docs/healthcare/test-mode

### Medplum (FHIR) — THE WORKFLOW ENGINE
- **Cost:** Free open-source + hosted tier
- **What to build with it:**
  - `Claim` + `ClaimResponse` — the money lifecycle (triage + appeal)
  - `Encounter` + `ServiceRequest` — discharge trigger + care-gap detection
  - `Task` — the state machine for every agent's work
  - `Patient`, `Appointment`, `Coverage` — clinical context
  - `Subscriptions` + Bots — the event stream that wakes every agent
- **Key docs:** https://www.medplum.com/docs/api

### Moss (Real-Time Semantic Search) — THE CRITERIA BRAIN
- **Judge connection:** Sri Raghu Malireddi (Moss founder) is a judge
- **What to build with it:**
  - **Payer clinical-criteria index** — what evidence does Blue Shield require for MRI coverage? The triage agent uses this to *prevent* denials; the appeal agent uses it to *win* them.
  - **Care protocols** — what's the recommended follow-up after discharge? What screenings are due?
- **Key docs:** https://docs.moss.dev

### Deepgram (Voice AI) — THE HUMAN TOUCH
- **Product:** Deepgram Voice Agent API + STT + TTS
- **Credits:** $200 free + Startup Program up to $100K
- **What to build with it:**
  - **Outbound discharge call** — the agent *calls* the patient (voice is proactive here, not reactive)
  - Function calling → Medplum (book follow-up), Stedi (verify coverage), Twilio (SMS)
- **Key docs:** https://developers.deepgram.com/docs/voice-agent

### Twilio (Telephony)
- **Product:** Outbound calls + SMS
- **What to build with it:** initiate the discharge call, bridge audio to Deepgram, send follow-up SMS
- **Key docs:** https://www.twilio.com/docs/voice/twiml/stream

---

## Architecture (Data Flow)

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
      └────▶│   THE APPEAL/PREVENTION ENGINE (shared pipeline)      │
            │   1. Parse intent        ← FHIR event                 │
            │   2. Retrieve criteria   ← Moss                       │
            │   3. Reason + act        ← LLM → Stedi / Twilio       │
            │   4. Write outcome       → Medplum Task               │
            │   5. Learn               → win-rate ledger            │
            └───────┬───────────────────────────────────────────────┘
                    │
                    ▼
     ┌──────────────────────────────────────────────┐
     │  Learning dashboard: win rate by denial      │
     │  reason, gaps closed, calls answered          │
     └──────────────────────────────────────────────┘

Discharge call path (outbound):
  Agent decides to call → Twilio REST API initiates call
    → patient's phone rings → Twilio connects to our /stream WS
    → Deepgram Voice Agent (outbound session) → function calls
      → Medplum (book follow-up), Stedi (verify coverage),
        Moss (care protocols), Twilio (SMS)
```

---

## Tech Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Agent engine** | Node worker + event router | 5 agents, one pipeline |
| **Workflow state** | Medplum FHIR (Claim, ClaimResponse, Task, Encounter, ServiceRequest) | The state machine |
| **Triggers** | Medplum Subscriptions + Bots | Wake the right agent |
| **Criteria brain** | Moss | Payer criteria + care protocols (sub-10ms) |
| **EDI** | Stedi (270/271, 837) | Eligibility, claims, resubmission |
| **Voice** | Deepgram Voice Agent + Twilio (outbound) | Discharge + care-gap calls |
| **LLM** | gpt-4o-mini (env-configurable) | Drafting + reasoning |
| **SMS** | Twilio | Confirmations + escalations |

---

## Demo Script (3 minutes)

**0:00–0:30** — *Problem*
"$30B in denied claims a year, 8 in 10 denied on first pass, and only 4% ever appealed — because a human takes 3 hours per appeal. Meanwhile patients fall through the cracks: no one calls after discharge, no one reminds them about overdue screenings. We built the back office that never sleeps."

**0:30–1:00** — *Live: prevention*
Screen shows a claim ready to submit. The **Claim Triage agent** checks it against Blue Shield's criteria (Moss) → catches it: *"Missing prior-auth paperwork for this MRI."* → fixes it → submits clean. "The agent prevents the denial before it happens."

**1:00–1:45** — *Live: the denial fights back*
The claim still comes back **DENIED** — medical necessity. The **Denial Appeal agent** takes over: parses the reason → retrieves the payer criteria → drafts the appeal with the missing evidence → resubmits. **APPROVED.** "That's a $2,400 claim won autonomously in 40 seconds."

**1:45–2:30** — *Live: the discharge call (the emotional peak)*
Agent calls Mrs. Rodriguez (real outbound call):
> Agent: *"Hi Maria, this is Maya from Dr. Smith's office checking in after your surgery. How are you feeling?"*  
> Maria: *"Pretty good, just some pain at the incision."*  
> Agent: *"Let me note that and make sure your follow-up is booked..."* (books follow-up via Medplum)  
> Agent: *"I also noticed you're overdue for your mammogram. I've verified it's covered — want me to book that too?"*  
> Maria: *"Yes, please."* (care gap closed, appointment created)

**2:30–3:00** — *Learning + Vision*
Dashboard: win rate by denial reason (82% on missing-docs appeals), gaps closed, calls answered. "Five agents, one platform, learning from every claim and every call. This is the operating system for the doctor's office of the future. We'd love a YC interview."

---

## Why This Wins

**We know what's out there.** Prosper AI, Plena, Assort — a dozen YC companies build AI *receptionists*. **Nobody builds the autonomous back office: prevention AND cure AND proactive care.** The receptionist race is crowded; this race is empty.

1. **Genuinely novel** — no competitor in the research does autonomous denial appeals, and none combine revenue-cycle automation with proactive outbound care coordination.

2. **The "AI as operating system" thesis, literally** — not one agent, a *workforce* of five, all on one engine, all learning. Diana Hu's thesis on screen.

3. **Two live demo moments** — a money win (prevention + appeal) AND a human win (live discharge call). One demo shows the full arc: *prevent → win → call → close the gap.*

4. **Real, massive pain** — $30B+ denied annually, <4% appealed, patients falling through the cracks. ROI is instant and calculable.

5. **All 5 sponsors used deeply** — Stedi (EDI + eligibility), Medplum (the whole workflow), Moss (criteria brain — founder is a judge), Deepgram (live outbound voice), Twilio (call + SMS).

6. **Built on the CMS-0057-F substrate** — payer data is becoming machine-readable at exactly the right time.

7. **Compounding moat** — the win-rate and gap-closure data are proprietary and get more valuable with every claim.

8. **Demonstrable in 3 minutes** — the entire arc fits the window.

### Competitive Comparison

| Competitor | Focus | Why They DON'T Do This |
|-----------|-------|------------------------|
| Prosper AI (YC S23, $30M) | AI receptionist + scheduling | Front-desk only; no appeals, no proactive calls |
| Plena Health (YC Sp26) | Specialty clinic OS | Billing visibility, not autonomous agents |
| Assort Health | Specialty voice AI | Voice intake, not claim resolution |
| Locata (YC W26) | Prior auth for referrals | Approves auth *before* care; doesn't fight denials or call patients |
| Patientdesk.ai (YC W26) | Scheduling only | Scheduling |
| Traditional denial mgmt (Ciox) | Manual denial management | Human-in-the-loop, slow, expensive |

**The gap:** everyone automates the front of the revenue cycle (book, verify, auth). Nobody automates the back (denied → won) AND the care side (discharge → gap closure) on one platform.

---

## Unit Economics

| Item | Cost | Notes |
|------|------|-------|
| **Deepgram Voice Agent** | ~$4.50/hr active | Outbound discharge calls are short (<5 min) |
| **Stedi transactions** | ~$0.05–0.30/txn | Eligibility + claim + resubmission |
| **LLM** | ~$0.05–0.20 per appeal/call | Small structured tasks |
| **Twilio** | ~$0.01/min voice + ~$0.0079/SMS | Outbound calls + confirmations |
| **Infrastructure** | ~$50–100/mo | Node worker + Medplum hosting |
| **Total COGS** | **~$150–250/mo** | Per clinic |

**Pricing: $299–499/mo per clinic**, or **25–30% of recovered claim value** (performance pricing). A single recovered claim covers a month's fee. Human denial management firms charge $20–60 per appeal.

---

## Before Hackathon Day

### Must-Do (Pre-Hackathon Integration Tests)

- [ ] Verify real eligibility signal: mock eligibility (medical STC `30`) returns `authOrCertIndicator: Y`
- [ ] Verify Aetna mock member ID (`AETNA9wcSu`) in the Stedi dashboard tester
- [ ] Build the Moss **payer criteria index** (Blue Shield MRI/CT/X-ray + care protocols)
- [ ] Wire Medplum `Subscription` → `isDenied()` → trigger appeal worker
- [ ] Wire `Subscription` on `Encounter` discharge → trigger discharge agent
- [ ] **Test outbound call flow**: Twilio REST `calls.create` → patient phone rings → `/stream` bridge → Deepgram outbound session (do this before demo day — it's the riskiest live moment)
- [ ] Confirm Moss npm import line matches installed package
- [ ] Seed demo patient (Jane Doe: Blue Shield PPO, MRI claim, surgery Encounter, overdue mammogram `ServiceRequest`)
- [ ] Pre-record fallback demo video (in case live APIs fail)
- [ ] Rehearse the 3-minute script at least 5× with someone who hasn't seen it

### General Prep

- [ ] Sign up for Deepgram → activate $200 credits
- [ ] Set up Medplum project → deploy test environment
- [ ] Explore Stedi test mode → confirm always-pays behavior
- [ ] Get Moss access (hackathon sponsor desk / usemoss.dev form)
- [ ] Join Medplum Discord → #hackathon channel
- [ ] Find 1-2 teammates (builder + someone who understands healthcare workflows)

---

## Key Risk & Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| Stedi test mode can't produce a real **denial** (835s always pay) | 🔴 High | Deterministic **denial simulator** (`stedi-mock.ts` + `DENIAL_RULES`): production-shaped, seeded by claim, anchored to real `authOrCertIndicator: Y` signal; disclose "denial payload simulated, loop real" |
| **Outbound call fails live** | 🔴 High | Pre-test the Twilio→Deepgram outbound bridge before demo day; pre-recorded fallback clip |
| Voice agent says something off-script on stage | 🟡 Medium | Tight prompt + hardcoded demo path; the money loop is the primary centerpiece, call is secondary |
| LLM down / weak output | 🟡 Medium | Template fallback mandatory; loop never blocks on LLM |
| Demo complexity (5 agents) | 🟡 Medium | Lock ONE seeded patient path; the timeline shows all 5 but only 2 run live |
| Duplicate processing of a denial | 🟡 Medium | Idempotency: check existing Task by focus reference |
| Crowded receptionist space | 🟢 Low (we're not in it) | Pitch leads with the back office, never the front desk |
