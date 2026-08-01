/**
 * Retrieval corpus loaded into Moss at boot (scripts/index-moss.ts) and used
 * to seed the built-in lexical fallback index. Contains NO PHI by design:
 * payer criteria, LCD/NCD snippets, denial-reason playbooks, internal SOPs.
 */

export interface CorpusDoc {
  id: string;
  text: string;
  metadata?: Record<string, string>;
}

export const CRITERIA_DOCS: CorpusDoc[] = [
  {
    id: 'bsc-mri-brain',
    text: 'Blue Shield PPO medical policy — MRI brain (CPT 70551, 70552, 70553): prior authorization is required. Coverage criteria: (1) documented ICD-10 diagnosis; (2) new focal neurological deficit, OR chronic headache with red-flag features (change in pattern, thunderclap onset, papilledema), OR failure of at least 4 weeks of documented conservative/medical management; (3) order and referral from the treating physician. Requests without prior authorization are denied CO-197 but are eligible for retroactive authorization review on appeal when submitted within 14 calendar days of the date of service with supporting clinical documentation.',
    metadata: { kind: 'criteria', payer: 'Blue Shield PPO', procedure: 'MRI brain', codes: '70551,70552,70553' },
  },
  {
    id: 'bsc-mri-lumbar',
    text: 'Blue Shield PPO medical policy — MRI lumbar spine (CPT 72148, 72158): prior authorization required. Criteria: at least 6 weeks of documented conservative therapy (physical therapy, NSAIDs) without improvement, UNLESS red flags are present: suspected cauda equina syndrome, progressive motor deficit, suspected malignancy or infection, or significant trauma. Imaging reports and therapy notes must accompany the request.',
    metadata: { kind: 'criteria', payer: 'Blue Shield PPO', procedure: 'MRI lumbar spine', codes: '72148,72158' },
  },
  {
    id: 'bsc-ct-abdomen',
    text: 'Blue Shield PPO medical policy — CT abdomen/pelvis (CPT 74176, 74177, 74178): prior authorization required. Coverage criteria: acute abdominal pain with suspected surgical pathology, follow-up of a known finding at a guideline-recommended interval, or staging of documented malignancy. Clinical indication must be documented in the ordering note.',
    metadata: { kind: 'criteria', payer: 'Blue Shield PPO', procedure: 'CT abdomen pelvis', codes: '74176,74177,74178' },
  },
  {
    id: 'cigna-mri-msk',
    text: 'Cigna coverage position — advanced imaging (MRI) for musculoskeletal indications: requires referral from the treating physician and a minimum of 4 weeks of documented conservative therapy (activity modification, analgesics, physical therapy) before advanced imaging, unless red flags are documented. Peer-to-peer review is available for medical-necessity denials.',
    metadata: { kind: 'criteria', payer: 'Cigna', procedure: 'MRI' },
  },
  {
    id: 'lcd-l34869-mri-head',
    text: 'LCD snippet (MRI of the head, L34869-style): MRI of the brain is considered medically necessary for chronic headache when there is a change in headache pattern or character, new neurological signs or symptoms, onset after age 50, or failure to respond to appropriate medical management. Documentation must include the clinical indication, prior treatments attempted, and their outcomes.',
    metadata: { kind: 'lcd', procedure: 'MRI brain' },
  },
  {
    id: 'ncd-220-4-mammography',
    text: 'NCD 220.4-style coverage (mammography): screening mammography (CPT 77067) is covered annually for women age 40 and older without symptoms; diagnostic mammography is covered when clinical findings are present. A screening is considered overdue when more than 27 months have elapsed since the prior screening. No prior authorization is required for screening mammography.',
    metadata: { kind: 'ncd', procedure: 'screening mammography', codes: '77067' },
  },
  {
    id: 'protocol-mammo-gap',
    text: 'Preventive care-gap protocol — breast cancer screening: patients aged 40-74 should complete screening mammography at least biennially (USPSTF B recommendation). When a patient is identified as overdue during any encounter or discharge coordination call, offer scheduling in the same interaction, verify coverage (no auth required for CPT 77067), and book within 30 days. Document the closed gap on the ServiceRequest.',
    metadata: { kind: 'protocol', topic: 'care-gap mammography' },
  },
  {
    id: 'protocol-postop-chole',
    text: 'Discharge protocol — post-operative laparoscopic cholecystectomy: contact the patient within 24-48 hours of discharge. Red flags requiring escalation to the surgical team: fever above 101F, worsening right-upper-quadrant or severe abdominal pain, jaundice, persistent vomiting, or wound drainage. Schedule surgical follow-up within 7-14 days. During the same outreach, screen for and close any open preventive care gaps.',
    metadata: { kind: 'protocol', topic: 'discharge cholecystectomy' },
  },
];

export const PLAYBOOK_SEED_DOCS: CorpusDoc[] = [
  {
    id: 'pb-co-197',
    text: 'Denial playbook CO-197 (precertification/authorization absent): strongest appeal path is a retroactive authorization request. Argue: (1) the service met the payer\'s own clinical criteria at the time of service — map the clinical facts to the policy line by line; (2) eligibility verification (271) flagged the authorization requirement and the plan permits retro-authorization within 14 days of service; (3) attach the clinical notes establishing necessity. Request: reprocess the claim with authorization applied retroactively.',
    metadata: { kind: 'playbook', denialCode: 'CO-197' },
  },
  {
    id: 'pb-co-50',
    text: 'Denial playbook CO-50 (not deemed medically necessary): rebut with the payer\'s own published criteria — quote each criterion and map the member\'s documented clinical facts to it. Attach peer-reviewed evidence (randomized trials, specialty-society guidelines) supporting the service for this indication, citing PMIDs. Request a peer-to-peer review with a same-specialty reviewer if the written appeal is not overturned.',
    metadata: { kind: 'playbook', denialCode: 'CO-50' },
  },
  {
    id: 'pb-co-16',
    text: 'Denial playbook CO-16 (claim lacks information / submission error): identify the specific missing element from the RARC remark codes, correct it, and resubmit as a replacement claim (claim frequency code 7) with complete documentation attached via 275. These are technical denials — speed matters more than argumentation; resubmit within the payer\'s correction window.',
    metadata: { kind: 'playbook', denialCode: 'CO-16' },
  },
  {
    id: 'pb-co-29',
    text: 'Denial playbook CO-29 (timely filing expired): appeal with proof of timely original submission — clearinghouse acknowledgment (999/277CA) showing the original submit date, plus the payer\'s published timely-filing exception policy. If the delay was caused by incorrect eligibility information from the payer, cite that as good cause.',
    metadata: { kind: 'playbook', denialCode: 'CO-29' },
  },
  {
    id: 'pb-co-11',
    text: 'Denial playbook CO-11 (diagnosis inconsistent with procedure): verify ICD-10/CPT pairing against the coding guidance; if the coding was correct, appeal with the clinical note showing the documented indication supports the procedure; if miscoded, submit a corrected replacement claim with the accurate diagnosis sequence.',
    metadata: { kind: 'playbook', denialCode: 'CO-11' },
  },
  {
    id: 'sop-appeal-format',
    text: 'Internal SOP — appeal letter format: (1) header with member name, member ID, claim number, date of service; (2) reference the denial reason code and date; (3) one-paragraph factual summary; (4) argument section mapping clinical facts to the payer\'s coverage criteria, with numbered points; (5) evidence section citing attached clinical documents and peer-reviewed literature; (6) explicit request (reprocess/overturn) and a response deadline; (7) signature block. Keep the letter under two pages.',
    metadata: { kind: 'sop', topic: 'appeal format' },
  },
];
