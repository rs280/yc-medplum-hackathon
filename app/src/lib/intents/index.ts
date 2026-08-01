import 'server-only';
import type { Claim, ClaimResponse, Encounter, Resource, ServiceRequest } from '@medplum/fhirtypes';
import { claimTriage } from './claim-triage';
import { denialAppeal } from './denial-appeal';
import { dischargeCaregap } from './discharge-caregap';
import { priorAuthDocs } from './prior-auth-docs';
import { codeOf, isDenied, PRIOR_AUTH_CODES, type IntentConfig, type IntentName } from './shared';

export * from './shared';

export const INTENTS: Record<IntentName, IntentConfig> = {
  'claim-triage': claimTriage,
  'denial-appeal': denialAppeal,
  'discharge-caregap': dischargeCaregap,
  'prior-auth-docs': priorAuthDocs,
};

export type ParsedEvent =
  | { kind: 'intent'; intent: IntentConfig }
  | { kind: 'feedback' }
  | { kind: 'ignore'; reason: string };

/**
 * Step 1 of the pipeline: map a FHIR event to an intent config. This is one of
 * only two places allowed to branch on intent (the other is act.ts).
 */
export function parseIntent(resource: Resource): ParsedEvent {
  switch (resource.resourceType) {
    case 'Claim': {
      const claim = resource as Claim;
      return claim.status === 'active'
        ? { kind: 'intent', intent: INTENTS['claim-triage'] }
        : { kind: 'ignore', reason: `Claim status '${claim.status}' (triage runs on active claims)` };
    }
    case 'ClaimResponse': {
      const cr = resource as ClaimResponse;
      if (isDenied(cr)) return { kind: 'intent', intent: INTENTS['denial-appeal'] };
      if (cr.outcome === 'complete') return { kind: 'feedback' };
      return { kind: 'ignore', reason: `ClaimResponse outcome '${cr.outcome}' is neither denial nor approval` };
    }
    case 'Encounter': {
      const enc = resource as Encounter;
      return enc.status === 'finished'
        ? { kind: 'intent', intent: INTENTS['discharge-caregap'] }
        : { kind: 'ignore', reason: `Encounter status '${enc.status}' (discharge runs on finished)` };
    }
    case 'ServiceRequest': {
      const sr = resource as ServiceRequest;
      const cpt = codeOf(sr.code);
      if (sr.status === 'active' && cpt && PRIOR_AUTH_CODES.has(cpt)) {
        return { kind: 'intent', intent: INTENTS['prior-auth-docs'] };
      }
      return { kind: 'ignore', reason: `ServiceRequest ${cpt ?? '?'} does not require prior auth (care gaps are handled inside discharge outreach)` };
    }
    default:
      return { kind: 'ignore', reason: `No intent for resourceType ${resource.resourceType}` };
  }
}
