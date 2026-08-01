import { NextResponse, type NextRequest } from 'next/server';
import { sendWhatsAppText } from '@/lib/whatsapp.server';

/** Dev utility: send an ad-hoc WhatsApp message through the linked account. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { to, text } = (await req.json()) as { to?: string; text?: string };
  if (!to || !text) return NextResponse.json({ error: 'to and text required' }, { status: 400 });
  const result = await sendWhatsAppText(to, text);
  return NextResponse.json(result);
}
