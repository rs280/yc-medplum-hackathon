/**
 * Create the four Medplum Subscriptions that wake the agents. Requires real
 * Medplum credentials plus a public WEBHOOK_BASE_URL (ngrok/cloudflared).
 * Idempotent. In demo-store mode this is unnecessary — `npm run demo` posts
 * events straight to the webhook with the same payload shape.
 */
import type { Subscription } from '@medplum/fhirtypes';
import { getRawMedplum } from '@/lib/medplum.server';

const SUBSCRIPTIONS: Array<{ reason: string; criteria: string }> = [
  { reason: 'claim-triage: claim ready to submit', criteria: 'Claim?status=active' },
  { reason: 'denial-appeal + outcome feedback: payer adjudication', criteria: 'ClaimResponse' },
  { reason: 'discharge-caregap: encounter finished', criteria: 'Encounter?status=finished' },
  { reason: 'prior-auth-docs: order needing authorization', criteria: 'ServiceRequest?status=active' },
];

async function main(): Promise<void> {
  const medplum = await getRawMedplum();
  if (!medplum) {
    console.log('[subscriptions] Medplum not configured — demo-store mode delivers events via `npm run demo` POSTs. Nothing to do.');
    return;
  }
  const base = process.env.WEBHOOK_BASE_URL;
  if (!base || base.includes('localhost')) {
    console.warn(`[subscriptions] WEBHOOK_BASE_URL is '${base}' — Medplum cloud cannot reach localhost; use an ngrok/cloudflared URL.`);
  }
  const endpoint = `${(base ?? 'http://localhost:3000').replace(/\/$/, '')}/api/webhooks/medplum`;
  const secret = process.env.MEDPLUM_WEBHOOK_SECRET;

  const existing = await medplum.searchResources('Subscription', { _count: '100' });
  for (const def of SUBSCRIPTIONS) {
    const dup = existing.find((s) => s.criteria === def.criteria && s.channel?.endpoint === endpoint);
    if (dup) {
      console.log(`= Subscription exists for '${def.criteria}' (${dup.id})`);
      continue;
    }
    const created = await medplum.createResource<Subscription>({
      resourceType: 'Subscription',
      status: 'active',
      reason: def.reason,
      criteria: def.criteria,
      channel: { type: 'rest-hook', endpoint, payload: 'application/fhir+json' },
      extension: secret
        ? [{ url: 'https://www.medplum.com/fhir/StructureDefinition/subscription-secret', valueString: secret }]
        : undefined,
    });
    console.log(`+ Subscription '${def.criteria}' → ${created.id}`);
  }
  console.log(`[subscriptions] done — endpoint ${endpoint}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
