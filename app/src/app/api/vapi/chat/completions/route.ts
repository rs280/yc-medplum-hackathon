import { NextResponse, type NextRequest } from 'next/server';

export const maxDuration = 300;

/**
 * Vapi custom-LLM hook (OpenAI chat-completions shape). A phone caller's
 * words arrive here as messages; we run them through the app's own copilot
 * (/api/chat — real tools: register, book, checkout, run agents) and stream
 * the final reply back as SSE. Vapi handles telephony, Deepgram handles
 * voice; this route is the brain.
 */

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
}

/** Run the conversation through the local copilot endpoint and collect its final text. */
async function askCopilot(history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string> {
  const port = process.env.PORT || '3000';
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: history }),
  });
  if (!res.body) throw new Error('copilot returned no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const texts: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type: string; text?: string };
        if (event.type === 'text' && event.text) texts.push(event.text);
      } catch {
        // Non-JSON noise in the stream is ignorable.
      }
    }
  }
  return texts.join(' ').trim() || 'Sorry, could you say that again?';
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { messages?: OpenAiMessage[]; stream?: boolean };
  try {
    body = (await req.json()) as { messages?: OpenAiMessage[]; stream?: boolean };
  } catch {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
  }

  // Vapi's own system prompt is dropped — the copilot has its own brain.
  const history = (body.messages ?? [])
    .filter((m): m is OpenAiMessage & { content: string } => Boolean(m.content) && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    history.push({ role: 'user', content: 'Hello?' });
  }

  const reply = await askCopilot(history);
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-vapi-${created}`;

  if (body.stream === false) {
    return NextResponse.json({
      id,
      object: 'chat.completion',
      created,
      model: 'clinic-copilot',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    });
  }

  // SSE: one content delta, then the stop chunk, then [DONE].
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'clinic-copilot', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(chunk({ role: 'assistant', content: reply }, null)));
      controller.enqueue(encoder.encode(chunk({}, 'stop')));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}
