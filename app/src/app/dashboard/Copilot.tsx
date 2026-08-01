'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Back-office copilot panel: Cursor-style side chat for clinicians and
 * front-desk staff. Streams NDJSON from /api/chat, renders tool steps as
 * they run, refreshes the dashboard when an agent fires, and supports voice
 * in (Web Speech API) + optional voice out (speechSynthesis).
 */

interface Step {
  id: string;
  name: string;
  summary: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  steps: Step[];
}

const SUGGESTIONS = [
  'What’s our appeal win rate?',
  'Appeal the denial on claim 1',
  'The payer approved claim 1',
  'Run discharge outreach',
  'Start the prior auth for the MRI',
  'Show me the latest appeal letter',
];

const STEP_ICONS: Record<Step['status'], string> = { running: '◌', done: '✓', error: '!' };

export function Copilot() {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const voiceRepliesRef = useRef(voiceReplies);
  voiceRepliesRef.current = voiceReplies;
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    const w = window as any;
    setVoiceSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  // ⌘K / Ctrl-K focuses the copilot from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const speak = useCallback((text: string) => {
    if (!voiceRepliesRef.current || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 600));
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  }, []);

  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? inputRef.current?.value ?? '').trim();
      if (!text || busy) return;
      setInput('');
      setBusy(true);

      const history = [
        ...messagesRef.current.filter((m) => m.text || m.steps.length).map((m) => ({ role: m.role, content: m.text || '(ran tools)' })),
        { role: 'user' as const, content: text },
      ];
      setMessages((prev) => [...prev, { role: 'user', text, steps: [] }, { role: 'assistant', text: '', steps: [] }]);

      const patchAssistant = (fn: (m: Msg) => Msg) =>
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = fn(next[next.length - 1]);
          return next;
        });

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: history }),
        });
        if (!res.ok || !res.body) throw new Error(`copilot request failed (${res.status})`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let spoken = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let event: any;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event.type === 'text') {
              spoken += (spoken ? ' ' : '') + event.text;
              patchAssistant((m) => ({ ...m, text: m.text ? `${m.text}\n\n${event.text}` : event.text }));
            } else if (event.type === 'tool') {
              patchAssistant((m) => {
                const steps = [...m.steps];
                const i = steps.findIndex((s) => s.id === event.id);
                const step: Step = { id: event.id, name: event.name, summary: event.summary ?? steps[i]?.summary ?? event.name, status: event.status, detail: event.detail };
                if (i >= 0) steps[i] = { ...steps[i], ...step };
                else steps.push(step);
                return { ...m, steps };
              });
              if (event.refresh) router.refresh();
            } else if (event.type === 'error') {
              patchAssistant((m) => ({ ...m, text: m.text ? `${m.text}\n\nError: ${event.message}` : `Error: ${event.message}` }));
            }
          }
        }
        if (spoken) speak(spoken);
      } catch (err) {
        patchAssistant((m) => ({ ...m, text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` }));
      } finally {
        setBusy(false);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    },
    [busy, router, speak],
  );

  const toggleMic = useCallback(() => {
    const w = window as any;
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognitionRef.current = recognition;
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = '';
    recognition.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      setInput(finalText + interim);
    };
    recognition.onend = () => {
      setListening(false);
      const text = finalText.trim();
      if (text) send(text);
    };
    recognition.onerror = () => setListening(false);
    setListening(true);
    setInput('');
    recognition.start();
  }, [listening, send]);

  if (!open) {
    return (
      <button className="copilot-fab" onClick={() => setOpen(true)} title="Open copilot (⌘K)">
        ✦ Copilot
      </button>
    );
  }

  return (
    <aside className="copilot">
      <div className="copilot-head">
        <div>
          <div className="copilot-title">✦ Copilot</div>
          <div className="copilot-sub">voice + chat · runs the agents for you</div>
        </div>
        <div className="copilot-head-actions">
          <button
            className={`icon-btn ${voiceReplies ? 'active' : ''}`}
            onClick={() => {
              if (voiceReplies) window.speechSynthesis?.cancel();
              setVoiceReplies((v) => !v);
            }}
            title={voiceReplies ? 'Voice replies on' : 'Voice replies off'}
          >
            {voiceReplies ? '🔊' : '🔇'}
          </button>
          <button className="icon-btn" onClick={() => setOpen(false)} title="Collapse">
            ✕
          </button>
        </div>
      </div>

      <div className="copilot-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="copilot-empty">
            <p>
              Ask in plain language — I check status, draft appeals, run patient outreach, and file prior auths on the
              live pipeline. Press <kbd>⌘K</kbd> anytime{voiceSupported ? ', or tap the mic and just talk' : ''}.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.steps.length > 0 && (
              <div className="steps">
                {m.steps.map((s) => (
                  <div key={s.id} className={`step ${s.status}`} title={s.detail}>
                    <span className="step-icon">{STEP_ICONS[s.status]}</span>
                    <span className="step-name">{s.name === 'run_agent' ? 'run agent' : s.name.replace(/_/g, ' ')}</span>
                    <span className="step-summary">{s.summary}</span>
                  </div>
                ))}
              </div>
            )}
            {m.text && <div className="bubble">{m.text}</div>}
            {m.role === 'assistant' && !m.text && m.steps.length === 0 && busy && i === messages.length - 1 && (
              <div className="bubble thinking">
                <span className="pulse-dot" /> thinking…
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="composer">
        {voiceSupported && (
          <button className={`mic-btn ${listening ? 'listening' : ''}`} onClick={toggleMic} disabled={busy} title={listening ? 'Stop listening' : 'Speak'}>
            {listening ? '●' : '🎙'}
          </button>
        )}
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          placeholder={listening ? 'Listening…' : 'Ask or tell the back office… (⌘K)'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy && !listening}
        />
        <button className="send-btn" onClick={() => send()} disabled={busy || !input.trim()} title="Send">
          ↑
        </button>
      </div>
    </aside>
  );
}
