# System Architecture — "The Autonomous Back Office"

> Rendered on GitHub as Mermaid. This matches `AGENTS.md` §§2–5.8.

## High-level system

```mermaid
flowchart TB
    subgraph Sponsors["Sponsor Services"]
        MEDPLUM["Medplum<br/>FHIR R4 + Subscriptions"]
        STEDI["Stedi<br/>Eligibility / Claims EDI"]
        MOSS["Moss<br/>Semantic Search"]
        DEEPGRAM["Deepgram<br/>Voice Agent"]
        TWILIO["Twilio<br/>Voice + SMS"]
        PUBMED["PubMed E-utilities<br/>(free evidence)"]
    end

    subgraph Engine["THE AGENT PLATFORM (one Node server)"]
        subgraph Triggers["FHIR Event Stream"]
            E1["Claim created"]
            E2["ClaimResponse denied"]
            E3["Encounter finished"]
            E4["ServiceRequest needs auth"]
        end

        ROUTER["Event Router<br/>(idempotent, Task-by-focus)"]

        subgraph Agents["5 Agent Handlers"]
            A1["Claim Triage<br/>(prevention)"]
            A2["Denial Appeal<br/>(cure + evidence)"]
            A3["Discharge Coordinator"]
            A4["Care-Gap Agent"]
            A5["Prior-Auth Docs"]
        end

        subgraph Pipeline["THE AGENT PIPELINE (shared)"]
            P1["1. Parse intent"]
            P2["2. REDACT PHI"]
            P3["3. Retrieve context<br/>Moss + PubMed"]
            P4["4. Reason + act<br/>(LLM)"]
            P5["5. De-redact"]
            P6["6. Write outcome → Medplum Task"]
            P7["7. Learn → memory"]
        end

        DASH["Learning Dashboard<br/>win-rate, evidence, redaction counter"]
        MEMORY["Memory<br/>win-rate ledger + provider prefs"]
    end

    MEDPLUM --> E1 & E2 & E3 & E4
    E1 & E2 & E3 & E4 --> ROUTER
    ROUTER --> A1 & A2 & A3 & A5
    A3 --> A4
    A1 & A2 & A3 & A4 & A5 --> Pipeline

    P2 -.->|de-identified| MOSS
    P3 --> MOSS
    P3 --> PUBMED
    P4 -.->|de-identified| DEEPGRAM
    P5 --> STEDI
    P5 --> TWILIO
    P6 --> MEDPLUM
    P7 --> MEMORY
    MEMORY --> DASH
    P6 --> DASH

    STEDI -.->|"real signal: authOrCertIndicator"| P2
```

## Outbound call path (discharge + care-gap)

```mermaid
sequenceDiagram
    participant ENC as Medplum Encounter (finished)
    participant AG as Discharge Coordinator
    participant TW as Twilio REST
    participant WB as /twilio/outbound-voice (TwiML)
    participant WS as /stream WebSocket bridge
    participant DG as Deepgram Voice Agent
    participant FH as Medplum (Appointment / Task)
    participant ST as Stedi (verify coverage)
    participant PAT as Patient's Phone

    ENC->>AG: Subscription: Encounter.status = finished
    AG->>TW: calls.create({ to, from, url })
    TW->>WB: GET → TwiML <Connect><Stream>
    WB-->>PAT: phone rings
    PAT->>WS: audio (μ-law base64)
    WS->>DG: forward audio (no transcode)
    DG-->>DG: agent.think → book_follow_up / check_care_gaps / verify_coverage
    DG->>WS: AgentV1Audio (mulaw)
    WS-->>PAT: audio
    DG->>FH: create Appointment (provider prefs)
    DG->>ST: 270/271 eligibility check
    DG-->>PAT: "coverage confirmed, booked 14 days out"
    AG->>FH: update Task → in-progress / completed
```

## Privacy / redaction data flow

```mermaid
flowchart LR
    FHIR["FHIR resource<br/>(real PHI)"] --> RED["redact()<br/>names→PATIENT_1, DOB→age..."]
    RED --> EXT1["LLM (de-identified)"]
    RED --> EXT2["Moss (de-identified)"]
    RED --> EXT3["PubMed (de-identified)"]
    EXT1 --> DERED["deRedact()"]
    EXT2 -.-> DERED
    EXT3 -.-> DERED
    DERED --> ACT["Action → Stedi / Twilio / Medplum<br/>(authorized PHI processors)"]
    DERED -->|unmapped token| FAIL["REJECT (fail closed)"]
```

## Full text diagram (plain text fallback)

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SPONSOR SERVICES                              │
│  Medplum(FHIR)  Stedi(EDI)  Moss(search)  Deepgram(voice)  Twilio    │
│  PubMed E-utilities(free evidence)                                  │
└──────────────────────────────────────────────────────────────────────┘
                          │ Medplum Subscriptions (event stream)
                          │
      ┌───────────────────┼──────────────────┬────────────────┐
      ▼                   ▼                  ▼                ▼
  Claim created      ClaimResponse      Encounter        ServiceRequest
      │                denied            finished       needs prior auth
      ▼                   ▼                  ▼                ▼
  ┌────────┐       ┌──────────┐     ┌────────────────┐  ┌─────────────┐
  │ Claim  │       │ Denial   │     │ Discharge Coord│  │ Prior-Auth  │
  │ Triage │       │ Appeal   │     │ + Care-Gap     │  │ Docs Agent  │
  └────┬───┘       └────┬─────┘     └────────┬───────┘  └──────┬──────┘
       │                │                    │                 │
       │      ┌─────────▼────────────────────▼─────────────────▼──────┐
       └─────▶│  THE AGENT PIPELINE (shared)                         │
              │  1. Parse intent        ← FHIR event                 │
              │  2. REDACT PHI          ← de-identify before outbound│
              │  3. Retrieve criteria   ← Moss + PubMed evidence     │
              │  4. Reason + act        ← LLM → Stedi / Twilio       │
              │  5. De-redact           ← re-inject PHI              │
              │  6. Write outcome       → Medplum Task               │
              │  7. Learn               → memory ledger               │
              └───────┬──────────────────────────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────┐
   │ Learning dashboard: win rate by denial        │
   │ reason, gaps closed, evidence + PHI counter   │
   └──────────────────────────────────────────────┘
```
