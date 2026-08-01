import { NextResponse, type NextRequest } from 'next/server';
import { describeForPanel, readPatientDocument, type AttachedImage } from '@/lib/documentRedaction.server';
import { getLlmClient, chatModelId } from '@/lib/llmClient';
import { filePatientDocument } from '@/lib/patientDocuments.server';
import { PatientError } from '@/lib/patients.server';

/**
 * Two steps, deliberately separate: `read` runs the vision pass and persists
 * NOTHING, then the browser burns the boxes on and posts the safe copy back as
 * `file`. The unredacted image only ever exists inside the read call, which is
 * the same contract the copilot's attachment path has always had.
 */

const IMAGE_MEDIA_TYPES: ReadonlyArray<AttachedImage['mediaType']> = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

// 12 MB of bytes, which base64 inflates by about a third.
const MAX_BASE64_LENGTH = 17 * 1024 * 1024;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseImage(body: Record<string, unknown>): AttachedImage | null {
  const mediaType = str(body.mediaType);
  const base64 = typeof body.base64 === 'string' ? body.base64 : undefined;
  if (!mediaType || !base64) return null;
  if (!IMAGE_MEDIA_TYPES.includes(mediaType as AttachedImage['mediaType'])) return null;
  if (base64.length > MAX_BASE64_LENGTH) return null;
  return { mediaType: mediaType as AttachedImage['mediaType'], base64 };
}

/** POST /api/patients/documents — read a document, or file an already-redacted copy. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Body is not JSON.' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json({ error: 'Body is not an object.' }, { status: 400 });
  }

  const body = raw as Record<string, unknown>;
  const action = str(body.action);

  try {
    if (action === 'read') {
      const image = parseImage(body);
      if (!image) return NextResponse.json({ error: 'Expected a supported image under 12 MB.' }, { status: 400 });

      const client = getLlmClient();
      if (!client) {
        // No key: nothing can be located, so nothing may be filed. Say so
        // rather than storing an unredacted image.
        return NextResponse.json({ error: 'No model is configured to read documents.' }, { status: 503 });
      }
      const reading = await readPatientDocument(client, chatModelId(), image);
      return NextResponse.json({
        documentType: reading.documentType,
        boxes: reading.boxes,
        // Masked on the way out — these are stored, and storing them in full
        // would defeat the burn-in.
        fields: describeForPanel(reading.fields),
      });
    }

    if (action === 'file') {
      const patientId = str(body.patientId);
      const image = parseImage(body);
      if (!patientId) return NextResponse.json({ error: 'A patientId is required.' }, { status: 400 });
      if (!image) return NextResponse.json({ error: 'Expected a supported image under 12 MB.' }, { status: 400 });

      const fields = Array.isArray(body.fields) ? body.fields.filter((f): f is string => typeof f === 'string') : [];
      const result = await filePatientDocument({
        patientId,
        base64: image.base64,
        mediaType: image.mediaType,
        fileName: str(body.fileName) ?? 'document.jpg',
        documentType: str(body.documentType) ?? 'document',
        maskedFields: fields,
        boxCount: typeof body.boxCount === 'number' ? body.boxCount : 0,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: `Unrecognised action '${action ?? ''}'.` }, { status: 400 });
  } catch (err) {
    if (err instanceof PatientError) {
      return NextResponse.json({ error: err.message }, { status: err.code === 'not_found' ? 404 : 400 });
    }
    console.error('[patients] document request failed:', err);
    return NextResponse.json({ error: 'Could not process that document.' }, { status: 500 });
  }
}
