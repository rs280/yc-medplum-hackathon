import { NextResponse, type NextRequest } from 'next/server';
import { ensureFrontDesk, vapiConfigured } from '@/lib/vapi.server';

/**
 * One-shot Vapi provisioning: GET /api/vapi/setup?url=<public-url> (or set
 * VAPI_PUBLIC_URL). Creates/updates the front-desk assistant and phone
 * number, and returns the number to call.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!vapiConfigured()) return NextResponse.json({ error: 'VAPI_API_KEY is not set' }, { status: 400 });
  const publicUrl = (req.nextUrl.searchParams.get('url') || process.env.VAPI_PUBLIC_URL || '').replace(/\/$/, '');
  if (!publicUrl.startsWith('https://')) {
    return NextResponse.json(
      { error: 'Pass ?url=https://<tunnel> or set VAPI_PUBLIC_URL — Vapi must be able to reach this server.' },
      { status: 400 },
    );
  }
  try {
    const result = await ensureFrontDesk(publicUrl);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
