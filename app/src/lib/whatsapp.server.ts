import 'server-only';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * WhatsApp via Baileys (unofficial WhatsApp Web protocol) — no Meta API key.
 * Set WHATSAPP_WEB=true, restart, and scan the QR printed in the server
 * terminal with your phone (WhatsApp → Linked devices). Credentials persist
 * in .whatsapp-auth/ so scanning is a one-time step. Personal-account ToS
 * gray area: demo use only. Without the flag (or before the QR is scanned,
 * or when a send fails) this returns a deterministic simulated ack — same
 * message in, same id out — so the pipeline never blocks.
 */

const AUTH_DIR = join(process.cwd(), '.whatsapp-auth');
const CONNECT_TIMEOUT_MS = 15_000;

export interface WhatsAppSendResult {
  messageId: string;
  to: string;
  simulated: boolean;
}

const g = globalThis as unknown as { __waSocket?: Promise<any>; __waRetries?: number };

const MAX_RECONNECTS = 5;

function enabled(): boolean {
  return process.env.WHATSAPP_WEB === 'true' || process.env.WHATSAPP_WEB === '1';
}

export function whatsappMode(): 'live' | 'simulated' {
  return enabled() ? 'live' : 'simulated';
}

/** Connect (or reuse) the WhatsApp Web socket; resolves once the connection is open. */
function getSocket(): Promise<any> | null {
  if (!enabled()) return null;
  g.__waSocket ??= (async () => {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import('@whiskeysockets/baileys');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const socket = makeWASocket({ auth: state });
    socket.ev.on('creds.update', saveCreds);
    return new Promise((resolve, reject) => {
      socket.ev.on('connection.update', (update: any) => {
        if (update.qr) {
          console.log('[whatsapp] scan this QR with your phone (WhatsApp → Linked devices):');
          void import('qrcode-terminal').then((qr) => qr.default.generate(update.qr, { small: true }));
        }
        if (update.connection === 'open') {
          console.log('[whatsapp] connected as', socket.user?.id);
          g.__waRetries = 0;
          resolve(socket);
        }
        if (update.connection === 'close') {
          const loggedOut = update.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
          g.__waSocket = undefined;
          // WhatsApp forces a stream restart right after QR pairing — reconnect
          // automatically (bounded, so a hard failure can't loop forever).
          if (!loggedOut && (g.__waRetries ?? 0) < MAX_RECONNECTS) {
            g.__waRetries = (g.__waRetries ?? 0) + 1;
            console.log(`[whatsapp] connection closed — reconnecting (${g.__waRetries}/${MAX_RECONNECTS})…`);
            setTimeout(() => getSocket()?.catch(() => undefined), 1000);
          } else {
            console.warn(`[whatsapp] connection closed${loggedOut ? ' (logged out — delete .whatsapp-auth/ and rescan)' : ''}`);
          }
          reject(new Error('whatsapp connection closed'));
        }
      });
    });
  })();
  return g.__waSocket;
}
// Warm at boot so the QR prints at server start, not mid-demo.
if (enabled()) getSocket()?.catch(() => undefined);

function simulatedAck(to: string, text: string): WhatsAppSendResult {
  const hash = createHash('sha1').update(`${to}|${text}`).digest('hex').slice(0, 10).toUpperCase();
  return { messageId: `wamid.SIM-${hash}`, to, simulated: true };
}

/** Send a text message to a phone number via the linked personal WhatsApp account. */
export async function sendWhatsAppText(toPhone: string, text: string): Promise<WhatsAppSendResult> {
  const to = toPhone.replace(/[^0-9]/g, '');
  const pending = getSocket();
  if (pending) {
    try {
      // Don't hang the pipeline waiting for a QR scan that may never come.
      const socket = await Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('whatsapp not connected yet')), CONNECT_TIMEOUT_MS)),
      ]);
      const sent = await (socket as any).sendMessage(`${to}@s.whatsapp.net`, { text });
      return { messageId: sent?.key?.id ?? 'wamid.UNKNOWN', to, simulated: false };
    } catch (err) {
      console.warn('[whatsapp] send failed, simulating:', err instanceof Error ? err.message : err);
    }
  }
  return simulatedAck(to, text);
}
