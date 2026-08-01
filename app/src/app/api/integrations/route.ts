import { NextResponse, type NextRequest } from 'next/server';
import { listIntegrationStates, setIntegrationEnabled } from '@/lib/integrationSettings.server';

/** Read and write integration enablement — the Integrations page is the only caller. */

export async function GET(): Promise<NextResponse> {
  const states = await listIntegrationStates();
  return NextResponse.json({ integrations: states });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { id?: unknown; enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
  }

  const { id, enabled } = body;
  if (typeof id !== 'string' || typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'expected { id: string, enabled: boolean }' }, { status: 400 });
  }

  try {
    await setIntegrationEnabled(id, enabled);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'toggle failed';
    const status = message.startsWith('unknown integration') ? 404 : 500;
    console.error('[integrations] toggle failed:', err);
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ id, enabled });
}
