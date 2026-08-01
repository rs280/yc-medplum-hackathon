import { createHmac, timingSafeEqual } from 'node:crypto';
import { after } from 'next/server';
import { NextResponse, type NextRequest } from 'next/server';
import type { Resource } from '@medplum/fhirtypes';
import { runPipeline } from '@/lib/pipeline';

/**
 * Medplum Subscription rest-hook receiver (all four Subscriptions point here).
 * Verifies the HMAC signature (X-Signature, hex sha256 of the raw body with
 * the subscription secret), acks fast, and runs the pipeline via after().
 */

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();

  const secret = process.env.MEDPLUM_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers.get('x-signature') ?? '';
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const valid =
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) {
      return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
    }
  }

  let resource: Resource;
  try {
    resource = JSON.parse(raw) as Resource;
  } catch {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
  }
  if (!resource?.resourceType) {
    return NextResponse.json({ error: 'body is not a FHIR resource' }, { status: 400 });
  }

  console.log(`[webhook] received ${resource.resourceType}/${resource.id}`);
  after(async () => {
    try {
      const result = await runPipeline(resource);
      console.log(`[webhook] pipeline finished for ${resource.resourceType}/${resource.id}:`, result);
    } catch (err) {
      console.error(`[webhook] pipeline crashed for ${resource.resourceType}/${resource.id}:`, err);
    }
  });

  return NextResponse.json({ received: true, resourceType: resource.resourceType, id: resource.id });
}
