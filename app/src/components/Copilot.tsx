'use client';

import {
  ArrowUp,
  BookOpenCheck,
  BrainCircuit,
  Crosshair,
  Dot,
  Lock,
  Mic,
  RefreshCcw,
  Search,
  Sparkles,
  Square,
  Unlock,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { renderRedacted } from '@/components/Redacted';

/**
 * Back-office copilot panel: Cursor-style side chat for clinicians and
 * front-desk staff. Streams NDJSON from /api/chat and renders the pipeline's
 * real internal steps live (redaction counts, retrieved sources, the actual
 * reasoning, actions taken) — not just a "done" chip — so the audience sees
 * the agent work, not a result. Refreshes the dashboard when an agent fires;
 * supports voice in (Web Speech API) + optional voice out (speechSynthesis).
 */

interface PipelineTrace {
  step: string;
  detail: string;
  data?: Record<string, unknown>;
}

interface Step {
  id: string;
  name: string;
  summary: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  trace: PipelineTrace[];
}

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  steps: Step[];
}

const SUGGESTIONS = [
  'Hi, I’m a new patient — sign me up',
  'Book me a check-up tomorrow morning',
  'My visit’s done — check me out',
  'Insurance denied my claim — fight it',
  'What’s our appeal win rate?',
  'Show me the latest appeal letter',
];

const STEP_ICONS: Record<Step['status'], string> = { running: '◌', done: '✓', error: '!' };

const TRACE_META: Array<{ match: (s: string) => boolean; Icon: typeof Lock; label: string }> = [
  { match: (s) => s.startsWith('parse-intent'), Icon: Crosshair, label: 'what happened' },
  { match: (s) => s === 'redact', Icon: Lock, label: 'hiding patient identity' },
  { match: (s) => s === 'retrieve', Icon: Search, label: 'reading the rules & research' },
  { match: (s) => s === 'reason', Icon: BrainCircuit, label: 'writing the response' },
  { match: (s) => s === 'de-redact', Icon: Unlock, label: 'restoring details' },
  { match: (s) => s === 'act', Icon: Zap, label: 'sending it' },
  { match: (s) => s === 'learn', Icon: BookOpenCheck, label: 'remembering what worked' },
  { match: (s) => s === 'feedback', Icon: RefreshCcw, label: 'updating the scoreboard' },
];

function traceMeta(step: string): { Icon: typeof Lock; label: string } {
  return TRACE_META.find((m) => m.match(step)) ?? { Icon: Dot, label: step };
}

function TraceEntry({ t }: { t: PipelineTrace }) {
  const { Icon, label } = traceMeta(t.step);
  const data = t.data ?? {};
  return (
    <div className="trace-entry">
      <div className="trace-head">
        <Icon className="trace-svg" size={13} strokeWidth={2.1} aria-hidden />
        <span className="trace-label">{label}</span>
        <span className="trace-detail">{t.detail}</span>
      </div>
      {Array.isArray(data.sources) && data.sources.length > 0 && (
        <div className="trace-chips">
          {(data.sources as Array<{ id: string; title: string }>).map((s) => (
            <span key={s.id} className="trace-chip" title={s.id}>
              {s.title}
            </span>
          ))}
        </div>
      )}
      {typeof data.rationale === 'string' && data.rationale && (
        <div className="trace-text">{renderRedacted(data.rationale)}</div>
      )}
      {Array.isArray(data.keyArguments) && data.keyArguments.length > 0 && (
        <ul className="trace-list">
          {(data.keyArguments as string[]).map((a, i) => (
            <li key={i}>{renderRedacted(a)}</li>
          ))}
        </ul>
      )}
      {typeof data.letterRedacted === 'string' && data.letterRedacted && (
        <pre className="trace-artifact">{renderRedacted(data.letterRedacted)}</pre>
      )}
      {Array.isArray(data.actions) && data.actions.length > 0 && (
        <div className="trace-chips">
          {(data.actions as Array<{ action: string; simulated?: boolean }>).map((a, i) => (
            <span key={i} className="trace-chip">
              {a.action}
              {a.simulated ? ' (sim)' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

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
                const base: Step = i >= 0 ? steps[i] : { id: event.id, name: event.name, summary: event.summary ?? event.name, status: event.status, trace: [] };
                const step: Step = { ...base, name: event.name, summary: event.summary ?? base.summary, status: event.status, detail: event.detail };
                if (i >= 0) steps[i] = step;
                else steps.push(step);
                return { ...m, steps };
              });
              if (event.refresh) router.refresh();
            } else if (event.type === 'pipeline') {
              patchAssistant((m) => {
                const steps = [...m.steps];
                const i = steps.findIndex((s) => s.id === event.toolId);
                if (i < 0) return m;
                steps[i] = { ...steps[i], trace: [...steps[i].trace, { step: event.step, detail: event.detail, data: event.data }] };
                return { ...m, steps };
              });
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
        <Sparkles size={14} aria-hidden /> Copilot
      </button>
    );
  }

  return (
    <aside className="copilot">
      <div className="copilot-head">
        <div>
          <div className="copilot-title">
            <Sparkles size={14} aria-hidden /> Copilot
          </div>
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
            aria-label={voiceReplies ? 'Turn voice replies off' : 'Turn voice replies on'}
          >
            {voiceReplies ? <Volume2 size={15} aria-hidden /> : <VolumeX size={15} aria-hidden />}
          </button>
          <button className="icon-btn" onClick={() => setOpen(false)} title="Collapse" aria-label="Collapse copilot">
            <X size={15} aria-hidden />
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
                  <div key={s.id} className={`step-block ${s.status}`}>
                    <div className="step" title={s.detail}>
                      <span className="step-icon">{STEP_ICONS[s.status]}</span>
                      <span className="step-name">{s.name === 'run_agent' ? 'run agent' : s.name.replace(/_/g, ' ')}</span>
                      <span className="step-summary">{s.summary}</span>
                    </div>
                    {s.trace.length > 0 && (
                      <div className="trace">
                        {s.trace.map((t, ti) => (
                          <TraceEntry key={ti} t={t} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {m.text && <div className="bubble">{renderRedacted(m.text)}</div>}
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
          <button
            className={`mic-btn ${listening ? 'listening' : ''}`}
            onClick={toggleMic}
            disabled={busy}
            title={listening ? 'Stop listening' : 'Speak'}
            aria-label={listening ? 'Stop listening' : 'Speak to the copilot'}
          >
            {listening ? <Square size={13} aria-hidden /> : <Mic size={15} aria-hidden />}
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
        <button className="send-btn" onClick={() => send()} disabled={busy || !input.trim()} title="Send" aria-label="Send message">
          <ArrowUp size={15} strokeWidth={2.4} aria-hidden />
        </button>
      </div>
    </aside>
  );
}
