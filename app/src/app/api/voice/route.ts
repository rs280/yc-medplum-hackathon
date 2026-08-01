import { NextResponse, type NextRequest } from 'next/server';
import type { Communication } from '@medplum/fhirtypes';
import { getStore, writeAudit } from '@/lib/medplum.server';

/**
 * Deepgram inbound: receives finalized call transcripts. Voice redaction is
 * Deepgram's job (enable `redact=pii` on the streaming/prerecorded request —
 * it covers audio-derived text only; everything else goes through redact.ts).
 * The transcript is stored in Medplum as a Communication on the audit trail.
 */

interface VoicePayload {
  patientId?: string;
  encounterId?: string;
  transcript?: string;
  channel?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: VoicePayload;
  try {
    body = (await req.json()) as VoicePayload;
  } catch {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
  }
  if (!body.transcript) {
    return NextResponse.json({ error: 'transcript required' }, { status: 400 });
  }

  const store = await getStore();
  const communication = await store.create<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    subject: body.patientId ? { reference: `Patient/${body.patientId}` } : undefined,
    encounter: body.encounterId ? { reference: `Encounter/${body.encounterId}` } : undefined,
    sent: new Date().toISOString(),
    category: [{ text: 'voice-transcript' }],
    payload: [{ contentString: body.transcript }],
  });
  await writeAudit(store, {
    subtype: 'voice-transcript',
    description: `Deepgram transcript stored (${body.transcript.length} chars, channel ${body.channel ?? 'unknown'})`,
    entities: [`Communication/${communication.id}`],
  });

  return NextResponse.json({ ok: true, communicationId: communication.id });
}
