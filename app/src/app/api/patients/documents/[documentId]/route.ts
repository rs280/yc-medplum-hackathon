import { NextResponse, type NextRequest } from 'next/server';
import { readDocumentBytes } from '@/lib/patientDocuments.server';

/**
 * Serves a filed document's bytes. The chart links here rather than inlining
 * base64, so a page that re-renders every few seconds stays small; the id is
 * immutable, so the browser can cache the response outright.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
): Promise<NextResponse> {
  const { documentId } = await params;
  try {
    const found = await readDocumentBytes(documentId);
    if (!found) return NextResponse.json({ error: 'No such document.' }, { status: 404 });
    return new NextResponse(new Uint8Array(found.bytes), {
      headers: {
        'content-type': found.contentType,
        'cache-control': 'private, max-age=3600, immutable',
      },
    });
  } catch (err) {
    console.error('[patients] document read failed:', err);
    return NextResponse.json({ error: 'Could not read that document.' }, { status: 500 });
  }
}
