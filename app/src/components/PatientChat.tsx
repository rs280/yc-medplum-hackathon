'use client';

import { ArrowUp, MessageCircle, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * Patient-facing copilot inside the mock phone on /patient. Talks to the same
 * /api/chat endpoint with persona:'patient', which swaps in a jargon-free
 * system prompt scoped to this one patient's care feed — no staff tools.
 */

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  kind?: 'status';
}

const PATIENT_SUGGESTIONS = [
  'I’m new here — sign me up',
  'Book me a check-up',
  'When is my next visit?',
  'What happened with my insurance?',
];

/** Per-patient conversation history, survives switching patients and navigating away. */
function historyKey(patientId?: string): string {
  return `patient-chat-${patientId ?? 'unknown'}`;
}

function loadHistory(patientId?: string): ChatMsg[] {
  try {
    return JSON.parse(sessionStorage.getItem(historyKey(patientId)) ?? '[]') as ChatMsg[];
  } catch {
    return [];
  }
}

export function PatientChat({ patientId, firstName }: { patientId?: string; firstName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Swap in this patient's own conversation whenever the phone changes hands.
  useEffect(() => {
    setMessages(loadHistory(patientId));
  }, [patientId]);

  useEffect(() => {
    if (messages.length > 0) sessionStorage.setItem(historyKey(patientId), JSON.stringify(messages));
  }, [messages, patientId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const history = [...messages, { role: 'user' as const, text: trimmed }];
    setMessages(history);
    setInput('');
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persona: 'patient',
          patientId,
          messages: history.map((m) => ({ role: m.role, content: m.text })),
        }),
      });
      if (!res.body) throw new Error('no response body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // The transcript grows as [history, interleaved status/text entries…];
      // status entries update in place by tool id as running → done.
      const entries: ChatMsg[] = [];
      const statusIndex = new Map<string, number>();
      let sawText = false;
      let needsRefresh = false;
      const sync = () => setMessages([...history, ...entries]);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as {
            type: string;
            text?: string;
            message?: string;
            id?: string;
            summary?: string;
            status?: string;
            refresh?: boolean;
          };
          if (event.type === 'text' && event.text) {
            sawText = true;
            const last = entries[entries.length - 1];
            if (last?.role === 'assistant' && !last.kind) last.text += ' ' + event.text;
            else entries.push({ role: 'assistant', text: event.text });
            sync();
          } else if (event.type === 'tool' && event.id) {
            const text =
              event.status === 'done' ? `✓ ${event.summary}` : event.status === 'error' ? `something went wrong ${event.summary}` : `${event.summary}…`;
            const at = statusIndex.get(event.id);
            if (at != null) entries[at] = { role: 'assistant', kind: 'status', text };
            else {
              statusIndex.set(event.id, entries.length);
              entries.push({ role: 'assistant', kind: 'status', text });
            }
            if (event.refresh) needsRefresh = true;
            sync();
          } else if (event.type === 'error') {
            throw new Error(event.message ?? 'chat failed');
          }
        }
      }
      if (!sawText) setMessages([...history, ...entries, { role: 'assistant', text: 'Sorry — please try that again.' }]);
      // New registration/booking changes who owns the phone — re-render the feed.
      if (needsRefresh) router.refresh();
    } catch {
      setMessages([...history, { role: 'assistant', text: 'Something went wrong — please try again, or call the clinic.' }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="phone-chat-fab" onClick={() => setOpen(true)} aria-label="Chat with your care assistant">
        <MessageCircle size={16} aria-hidden /> Ask us anything
      </button>
    );
  }

  return (
    <div className="phone-chat">
      <div className="phone-chat-head">
        <span>Care assistant</span>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close chat">
          <X size={13} aria-hidden />
        </button>
      </div>
      <div className="phone-chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="phone-chat-empty">
            Hi {firstName}! Ask about your visits, follow-ups, or insurance.
            <div className="phone-chat-suggestions">
              {PATIENT_SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`phone-msg ${m.role}${m.kind ? ` ${m.kind}` : ''}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="phone-msg assistant typing">…</div>}
      </div>
      <form
        className="phone-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message your clinic…"
          disabled={busy}
          aria-label="Message your clinic"
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send">
          <ArrowUp size={14} aria-hidden />
        </button>
      </form>
    </div>
  );
}
