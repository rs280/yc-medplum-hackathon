/**
 * The integration catalog Medplum documents (www.medplum.com/docs/integration),
 * plus the two this build wires directly (Stedi, Claude). Pure data — shared by
 * the server page and the client toggle, so neither owns the list.
 *
 * `envVars` names the credentials this app needs to actually drive the
 * integration. An empty list means Medplum supports it but the wiring lives in
 * a Medplum bot/subscription rather than in this app.
 */

export type IntegrationCategory =
  | 'Hackathon sponsors'
  | 'Billing & revenue cycle'
  | 'Clinical systems'
  | 'Labs & networks'
  | 'Communications'
  | 'Authentication & identity'
  | 'Artificial intelligence'
  | 'Observability & data'
  | 'Scheduling & payments'
  | 'Interop templates';

export interface Integration {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  docsUrl: string;
  envVars: string[];
  /** On by default when this build ships the wiring — stored settings override. */
  defaultEnabled: boolean;
}

/** Category render order — sponsors lead, then clinical work, plumbing last. */
export const CATEGORY_ORDER: IntegrationCategory[] = [
  'Hackathon sponsors',
  'Billing & revenue cycle',
  'Clinical systems',
  'Labs & networks',
  'Communications',
  'Artificial intelligence',
  'Authentication & identity',
  'Scheduling & payments',
  'Observability & data',
  'Interop templates',
];

export const INTEGRATION_CATALOG: Integration[] = [
  {
    id: 'medplum',
    name: 'Medplum',
    category: 'Hackathon sponsors',
    description: 'Open-source FHIR datastore — every resource this back office reads and writes.',
    docsUrl: 'https://www.medplum.com/docs',
    envVars: ['MEDPLUM_CLIENT_ID', 'MEDPLUM_CLIENT_SECRET'],
    defaultEnabled: true,
  },
  {
    id: 'deepgram',
    name: 'Deepgram',
    category: 'Hackathon sponsors',
    description: 'Speech-to-text, text-to-speech, and voice agents — PII redaction happens in-stream.',
    docsUrl: 'https://developers.deepgram.com/home',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'moss',
    name: 'Moss',
    category: 'Hackathon sponsors',
    description: 'Real-time semantic search runtime behind copilot retrieval.',
    docsUrl: 'https://www.medplum.com/blog/yc-medplum-hackathon-2026',
    envVars: ['MOSS_API_KEY'],
    defaultEnabled: true,
  },
  {
    id: 'y-combinator',
    name: 'Y Combinator',
    category: 'Hackathon sponsors',
    description: 'Host of the 2026 Medplum hackathon.',
    docsUrl: 'https://www.medplum.com/blog/yc-medplum-hackathon-2026',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'stedi',
    name: 'Stedi',
    category: 'Billing & revenue cycle',
    description: 'Clearinghouse for eligibility (270/271), claims (837), and remittance (835).',
    docsUrl: 'https://www.medplum.com/docs/integration/stedi',
    envVars: ['STEDI_API_KEY'],
    defaultEnabled: true,
  },
  {
    id: 'candid-health',
    name: 'Candid Health',
    category: 'Billing & revenue cycle',
    description: 'Revenue cycle management and insurance eligibility checks.',
    docsUrl: 'https://www.medplum.com/docs/integration/candid-health',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'epic',
    name: 'Epic Systems',
    category: 'Clinical systems',
    description: 'Read and write patient records in Epic over the FHIR API.',
    docsUrl: 'https://www.medplum.com/docs/integration/epic',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'health-gorilla-patient-360',
    name: 'Health Gorilla Patient 360',
    category: 'Clinical systems',
    description: 'Health information exchange — longitudinal records and ADT feeds.',
    docsUrl: 'https://www.medplum.com/docs/integration/health-gorilla',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'zus-health',
    name: 'Zus Health',
    category: 'Clinical systems',
    description: 'HIE with longitudinal care records and analytics.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'health-gorilla-labs',
    name: 'Health Gorilla Lab Network',
    category: 'Labs & networks',
    description: 'Send lab orders and receive structured results as FHIR.',
    docsUrl: 'https://www.medplum.com/docs/integration/health-gorilla',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'labcorp',
    name: 'Labcorp',
    category: 'Labs & networks',
    description: 'Lab orders and results through the Labcorp network.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'quest',
    name: 'Quest Diagnostics',
    category: 'Labs & networks',
    description: 'Lab orders and results through the Quest network.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'twilio-sms',
    name: 'Twilio SMS',
    category: 'Communications',
    description: 'Send and receive patient SMS as FHIR Communication resources.',
    docsUrl: 'https://www.medplum.com/docs/integration/twilio',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'efax',
    name: 'eFax',
    category: 'Communications',
    description: 'Send and receive faxes as FHIR Communication resources.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    category: 'Artificial intelligence',
    description: 'Reasoning engine behind the copilot — triage, appeals, and summaries.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: ['ANTHROPIC_API_KEY'],
    defaultEnabled: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'Artificial intelligence',
    description: 'Model routing for the copilot model picker.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: ['OPENROUTER_API_KEY'],
    defaultEnabled: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'Artificial intelligence',
    description: 'Large language models invoked from Medplum bots.',
    docsUrl: 'https://www.medplum.com/docs/integration/openai',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'okta',
    name: 'Okta',
    category: 'Authentication & identity',
    description: 'Okta SSO for clinicians and staff.',
    docsUrl: 'https://www.medplum.com/docs/auth/methods/okta',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'auth0',
    name: 'Auth0',
    category: 'Authentication & identity',
    description: 'Auth0 SSO for providers and patients.',
    docsUrl: 'https://www.medplum.com/docs/auth',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'google-auth',
    name: 'Google Authentication',
    category: 'Authentication & identity',
    description: 'Google SSO for providers and patients.',
    docsUrl: 'https://www.medplum.com/docs/auth/methods/google-auth',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'entra-sso',
    name: 'Microsoft Entra SSO',
    category: 'Authentication & identity',
    description: 'Microsoft Entra SSO for providers and patients.',
    docsUrl: 'https://www.medplum.com/docs/auth',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'recaptcha',
    name: 'reCAPTCHA',
    category: 'Authentication & identity',
    description: 'Bot protection on patient self-registration.',
    docsUrl: 'https://www.medplum.com/docs/auth',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Scheduling & payments',
    description: 'Sync payment and invoice data into FHIR.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'acuity-scheduling',
    name: 'Acuity Scheduling',
    category: 'Scheduling & payments',
    description: 'Third-party booking synced to FHIR Appointments.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'cal-com',
    name: 'Cal.com',
    category: 'Scheduling & payments',
    description: 'Open-source scheduling synced to FHIR Appointments.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'datadog',
    name: 'Datadog',
    category: 'Observability & data',
    description: 'Application monitoring and log forwarding.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'sumo-logic',
    name: 'Sumo Logic',
    category: 'Observability & data',
    description: 'Application monitoring and log analytics.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'snowflake',
    name: 'Snowflake',
    category: 'Observability & data',
    description: 'Synchronize FHIR data to the data warehouse.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'hl7-v2',
    name: 'HL7 V2',
    category: 'Interop templates',
    description: 'Connect legacy ADT and ORU feeds.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'smart-on-fhir',
    name: 'SMART on FHIR',
    category: 'Interop templates',
    description: 'Launch third-party apps in clinical context.',
    docsUrl: 'https://www.medplum.com/docs/integration/smart-app-launch',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'cds-hooks',
    name: 'CDS Hooks',
    category: 'Interop templates',
    description: 'Contextual clinical decision support inside the EHR.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'bulk-fhir',
    name: 'Bulk FHIR',
    category: 'Interop templates',
    description: 'Bulk export of FHIR data for partners and analytics.',
    docsUrl: 'https://www.medplum.com/docs/api/fhir/operations/bulk-fhir',
    envVars: [],
    defaultEnabled: true,
  },
  {
    id: 'sftp',
    name: 'SFTP',
    category: 'Interop templates',
    description: 'Scheduled file-based data synchronization.',
    docsUrl: 'https://www.medplum.com/docs/integration',
    envVars: [],
    defaultEnabled: true,
  },
];

export type IntegrationStatus = 'connected' | 'off';

/** Every switched-on integration reads as connected; credential state is not surfaced. */
export function integrationStatus(enabled: boolean): IntegrationStatus {
  return enabled ? 'connected' : 'off';
}

export const STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected: 'Connected',
  off: 'Off',
};

export const STATUS_TONE: Record<IntegrationStatus, string> = {
  connected: 'tone-good',
  off: 'tone-neutral',
};
