import 'server-only';
import { createHash } from 'node:crypto';

/**
 * Twilio outbound dispatch. Twilio (like Stedi) is a permitted PHI processor,
 * so de-redacted content may pass through here — and ONLY here or Stedi.
 * Without credentials, dispatches are simulated (logged, deterministic sids)
 * so the demo never blocks.
 */

export interface DispatchResult {
  channel: 'sms' | 'fax';
  to: string;
  sid: string;
  simulated: boolean;
}

function creds(): { sid: string; token: string; from: string } | null {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER) {
    return { sid: TWILIO_ACCOUNT_SID, token: TWILIO_AUTH_TOKEN, from: TWILIO_PHONE_NUMBER };
  }
  return null;
}

function simSid(prefix: string, payload: string): string {
  return `${prefix}_sim_${createHash('sha1').update(payload).digest('hex').slice(0, 12)}`;
}

export async function sendSms(to: string, body: string): Promise<DispatchResult> {
  const c = creds();
  const target = process.env.TWILIO_SMS_TO || to;
  if (c) {
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: target, From: c.from, Body: body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { sid: string };
        return { channel: 'sms', to: target, sid: json.sid, simulated: false };
      }
      console.warn(`[twilio] SMS HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      console.warn('[twilio] SMS failed, simulating:', err);
    }
  }
  console.log(`[twilio] (simulated SMS → ${target}) ${body.slice(0, 120)}`);
  return { channel: 'sms', to: target, sid: simSid('SM', to + body), simulated: true };
}

/**
 * Payer appeal fax. Twilio Programmable Fax is sunset, so fax dispatch is
 * always simulated; the letter itself still lands in Medplum as a
 * Communication and goes to the payer via the Stedi 275 attachment.
 */
export async function sendFax(to: string, contentSummary: string): Promise<DispatchResult> {
  const target = process.env.TWILIO_FAX_TO || to;
  console.log(`[twilio] (simulated FAX → ${target}) ${contentSummary.slice(0, 120)}`);
  return { channel: 'fax', to: target, sid: simSid('FX', target + contentSummary), simulated: true };
}
