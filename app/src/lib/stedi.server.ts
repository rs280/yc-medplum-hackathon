import 'server-only';
import { createHash } from 'node:crypto';

/**
 * Stedi EDI in/out. Real eligibility (270/271) works on a free sandbox key;
 * claims/attachments require a production account, so without STEDI_API_KEY
 * (or when a call fails) this module returns deterministic simulated acks —
 * same claim in, same control number out — so the demo is repeatable and the
 * pipeline never blocks. Every result is labeled `simulated`.
 */

const HEALTHCARE_BASE = 'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork';

function stediKey(): string | undefined {
  return process.env.STEDI_API_KEY || undefined;
}

function deterministicId(prefix: string, payload: unknown): string {
  const h = createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 10).toUpperCase();
  return `${prefix}-${h}`;
}

export interface EligibilityResult {
  payer: string;
  planStatus: string;
  authOrCertIndicator: 'Y' | 'N' | 'U';
  simulated: boolean;
}

/**
 * 270/271 eligibility. In live mode this uses Stedi's documented mock-payer
 * test values (Aetna 60054, subscriber Jane Doe / AETNA12345 / DOB 2004-04-04,
 * NPI 1999999984) — test mode only answers those exact fixtures, not our demo
 * patient. Mock 271s omit authOrCertIndicator entirely, so a missing indicator
 * maps to 'Y' to keep the demo's prior-auth-required story anchored.
 */
export async function checkEligibility(payerName: string): Promise<EligibilityResult> {
  const key = stediKey();
  if (key) {
    try {
      const res = await fetch(`${HEALTHCARE_BASE}/eligibility/v3`, {
        method: 'POST',
        headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradingPartnerServiceId: '60054',
          provider: { organizationName: 'Demo Provider', npi: '1999999984' },
          subscriber: { firstName: 'Jane', lastName: 'Doe', dateOfBirth: '20040404', memberId: 'AETNA12345' },
          encounter: { serviceTypeCodes: ['30'] },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        const benefits: any[] = json.benefitsInformation ?? [];
        // Mock 271s never carry the indicator; default 'Y' preserves the prior-auth demo beat.
        const auth = benefits.find((b) => b.authOrCertIndicator)?.authOrCertIndicator ?? 'Y';
        const active = benefits.some((b) => b.code === '1');
        return { payer: payerName, planStatus: active ? 'active' : 'unknown', authOrCertIndicator: auth, simulated: false };
      }
      console.warn(`[stedi] eligibility HTTP ${res.status}, simulating`);
    } catch (err) {
      console.warn('[stedi] eligibility failed, simulating:', err);
    }
  }
  return { payer: payerName, planStatus: 'active', authOrCertIndicator: 'Y', simulated: true };
}

export interface EdiAck {
  kind: '837' | '275' | '278' | '276';
  transactionId: string;
  controlNumber: string;
  status: 'accepted' | 'queued';
  simulated: boolean;
}

/** 837 professional claim submission (replacement claims use frequency code 7). */
export async function submitClaim837(payload: Record<string, unknown>): Promise<EdiAck> {
  return {
    kind: '837',
    transactionId: deterministicId('837', payload),
    controlNumber: deterministicId('ICN', payload),
    status: 'accepted',
    simulated: true,
  };
}

/** 275 attachment — carries the appeal packet / documentation to the payer. */
export async function sendAttachment275(payload: { claimRef: string; contentSummary: string }): Promise<EdiAck> {
  return {
    kind: '275',
    transactionId: deterministicId('275', payload),
    controlNumber: deterministicId('ATT', payload),
    status: 'accepted',
    simulated: true,
  };
}

/** 278 prior-authorization request. */
export async function submitPriorAuth278(payload: Record<string, unknown>): Promise<EdiAck> {
  return {
    kind: '278',
    transactionId: deterministicId('278', payload),
    controlNumber: deterministicId('AUTH', payload),
    status: 'accepted',
    simulated: true,
  };
}
