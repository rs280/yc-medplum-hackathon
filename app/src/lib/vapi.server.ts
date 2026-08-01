import 'server-only';

/**
 * Vapi telephony: provisions the clinic's phone line. Vapi supplies ONLY the
 * number + call plumbing — Deepgram does the voice (nova-3 STT, Aura TTS) and
 * the brain is this app's own copilot, reached via Vapi's custom-LLM hook at
 * ${publicUrl}/api/vapi/chat/completions. Requires VAPI_API_KEY; the public
 * URL comes from VAPI_PUBLIC_URL (a tunnel in dev). All calls are idempotent
 * (find-by-name) so /api/vapi/setup can be hit repeatedly.
 */

const VAPI_BASE = 'https://api.vapi.ai';
const ASSISTANT_NAME = 'Lakeside Front Desk';

export interface VapiSetupResult {
  assistantId: string;
  phoneNumber?: string;
  publicUrl: string;
}

function vapiKey(): string | undefined {
  return process.env.VAPI_API_KEY || undefined;
}

export function vapiConfigured(): boolean {
  return Boolean(vapiKey());
}

async function vapiFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${vapiKey()}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`vapi ${init?.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

/** The full assistant config — Deepgram both directions, our app as the model. */
function assistantConfig(publicUrl: string): Record<string, unknown> {
  return {
    name: ASSISTANT_NAME,
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
    voice: { provider: 'deepgram', voiceId: 'asteria' },
    model: {
      provider: 'custom-llm',
      url: `${publicUrl}/api/vapi`,
      model: 'clinic-copilot',
    },
    firstMessage:
      'Thanks for calling Lakeside Family Clinic! I can sign you up, book a visit, check you out after an appointment, or handle insurance questions. How can I help?',
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
  };
}

/** Create or update the front-desk assistant and make sure a Vapi number points at it. */
export async function ensureFrontDesk(publicUrl: string): Promise<VapiSetupResult> {
  const assistants = (await vapiFetch('/assistant')) as Array<{ id: string; name?: string }>;
  const existing = assistants.find((a) => a.name === ASSISTANT_NAME);
  const assistant = existing
    ? await vapiFetch(`/assistant/${existing.id}`, { method: 'PATCH', body: JSON.stringify(assistantConfig(publicUrl)) })
    : await vapiFetch('/assistant', { method: 'POST', body: JSON.stringify(assistantConfig(publicUrl)) });

  const numbers = (await vapiFetch('/phone-number')) as Array<{ id: string; number?: string; assistantId?: string }>;
  let number = numbers[0];
  if (!number) {
    try {
      number = await vapiFetch('/phone-number', {
        method: 'POST',
        body: JSON.stringify({ provider: 'vapi', name: 'Lakeside Front Desk line', assistantId: assistant.id }),
      });
    } catch (err) {
      console.warn('[vapi] free number provisioning failed:', err);
    }
  } else if (number.assistantId !== assistant.id) {
    number = await vapiFetch(`/phone-number/${number.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ assistantId: assistant.id }),
    });
  }

  return { assistantId: assistant.id, phoneNumber: number?.number, publicUrl };
}
