'use client';

import {
  ArrowUp,
  BookOpenCheck,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Dot,
  Hand,
  Lock,
  Mic,
  Paperclip,
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
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { renderRedacted } from '@/components/Redacted';
import { drawRedactedImage, loadAttachment, type ImageAttachment, type PhiBox } from '@/lib/chatImage';
import type { ChatModelOption } from '@/lib/models';

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
  attachmentName?: string;
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
  { match: (s) => s === 'redact-document', Icon: Lock, label: 'covering up the document' },
  { match: (s) => s === 'redact', Icon: Lock, label: 'hiding patient identity' },
  { match: (s) => s === 'retrieve', Icon: Search, label: 'reading the rules & research' },
  { match: (s) => s === 'reason', Icon: BrainCircuit, label: 'writing the response' },
  { match: (s) => s === 'de-redact', Icon: Unlock, label: 'restoring details' },
  { match: (s) => s === 'awaiting-approval', Icon: Hand, label: 'waiting for your approval' },
  { match: (s) => s === 'act', Icon: Zap, label: 'sending it' },
  { match: (s) => s === 'learn', Icon: BookOpenCheck, label: 'remembering what worked' },
  { match: (s) => s === 'feedback', Icon: RefreshCcw, label: 'updating the scoreboard' },
];

function traceMeta(step: string): { Icon: typeof Lock; label: string } {
  return TRACE_META.find((m) => m.match(step)) ?? { Icon: Dot, label: step };
}

function TraceEntry({ t, onDecision }: { t: PipelineTrace; onDecision?: (d: 'approve' | 'reject') => void }) {
  const { Icon, label } = traceMeta(t.step);
  const data = t.data ?? {};
  return (
    <div className="trace-entry">
      <div className="trace-head">
        <Icon className="trace-svg" size={13} strokeWidth={2.1} aria-hidden />
        <span className="trace-label">{label}</span>
        <span className="trace-detail">{t.detail}</span>
      </div>
      {/* The redacted render of an attached document — composited in the browser,
          so this is the only copy of it that ever existed in the transcript. */}
      {typeof data.redactedImage === 'string' && (
        <figure className="trace-image">
          <img
            src={data.redactedImage}
            alt={`Attached ${typeof data.documentType === 'string' ? data.documentType : 'document'}, identifying details blacked out`}
          />
          <figcaption>identifiers blacked out — the original was never kept</figcaption>
        </figure>
      )}
      {Array.isArray(data.fields) && data.fields.length > 0 && (
        <div className="trace-chips">
          {(data.fields as string[]).map((f) => (
            <span key={f} className="trace-chip">
              {f}
            </span>
          ))}
        </div>
      )}
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
      {t.step === 'awaiting-approval' && onDecision && (
        <div className="approval-actions">
          <button className="suggestion approve" onClick={() => onDecision('approve')}>
            <Check size={13} aria-hidden /> Approve &amp; send
          </button>
          <button className="suggestion reject" onClick={() => onDecision('reject')}>
            <X size={13} aria-hidden /> Reject
          </button>
        </div>
      )}
    </div>
  );
}

/** Header dropdown for choosing which model the copilot reasons with. */
function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ChatModelOption[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = models.find((model) => model.id === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        className={`model-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose the model behind the copilot"
      >
        <span className="model-orb" />
        <span className="model-name">{active?.label ?? 'Model'}</span>
        <ChevronDown size={13} aria-hidden />
      </button>

      {open && (
        <div className="model-menu" role="listbox">
          <div className="model-menu-head">Reasoning model</div>
          {models.map((model, i) => (
            <div key={model.id}>
              {/* The catalog is vendor-ordered, so a change of vendor starts a group. */}
              {model.vendor !== models[i - 1]?.vendor && <div className="model-group">{model.vendor}</div>}
              <button
                className={`model-option ${model.id === value ? 'selected' : ''}`}
                role="option"
                aria-selected={model.id === value}
                title={model.id}
                onClick={() => {
                  onChange(model.id);
                  setOpen(false);
                }}
              >
                <span className="model-option-label">{model.label}</span>
                <span className="model-option-note">{model.note}</span>
                {model.id === value && (
                  <span className="model-option-check">
                    <Check size={13} aria-hidden />
                  </span>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface CopilotProps {
  models: ChatModelOption[];
  defaultModel: string;
}

export function Copilot({ models, defaultModel }: CopilotProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [model, setModel] = useState(defaultModel);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const [attachError, setAttachError] = useState('');
  const modelRef = useRef(model);
  modelRef.current = model;
  const attachmentRef = useRef<ImageAttachment | null>(null);
  attachmentRef.current = attachment;
  const fileRef = useRef<HTMLInputElement>(null);
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
        setCollapsed(false);
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
      // The document is the message when someone just attaches a card and hits send.
      const pending = attachmentRef.current;
      if ((!text && !pending) || busy) return;
      setInput('');
      setAttachment(null);
      setAttachError('');
      setBusy(true);

      const prompt = text || 'Here is my insurance card.';
      const history = [
        ...messagesRef.current.filter((m) => m.text || m.steps.length).map((m) => ({ role: m.role, content: m.text || '(ran tools)' })),
        { role: 'user' as const, content: prompt },
      ];
      setMessages((prev) => [
        ...prev,
        { role: 'user', text: prompt, steps: [], attachmentName: pending?.fileName },
        { role: 'assistant', text: '', steps: [] },
      ]);

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
          body: JSON.stringify({
            messages: history,
            model: modelRef.current,
            attachment: pending ? { mediaType: pending.mediaType, base64: pending.base64 } : undefined,
          }),
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
              let data = event.data as Record<string, unknown> | undefined;
              // Boxes arrive as coordinates; the pixels are covered here, against
              // the local original, which is then dropped with `pending`.
              if (event.step === 'redact-document' && pending && Array.isArray(data?.boxes)) {
                try {
                  data = { ...data, redactedImage: await drawRedactedImage(pending.dataUrl, data.boxes as PhiBox[]) };
                } catch (err) {
                  console.warn('[copilot] could not render the redacted document:', err);
                }
              }
              patchAssistant((m) => {
                const steps = [...m.steps];
                const i = steps.findIndex((s) => s.id === event.toolId);
                if (i < 0) return m;
                steps[i] = { ...steps[i], trace: [...steps[i].trace, { step: event.step, detail: event.detail, data }] };
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

  // Normalizes the picked file locally; nothing is uploaded until send.
  const pickAttachment = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setAttachError('');
    try {
      setAttachment(await loadAttachment(file));
    } catch (err) {
      setAttachment(null);
      setAttachError(err instanceof Error ? err.message : 'That file could not be attached.');
    }
  }, []);

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

  // The patient-view page has its own in-phone patient copilot; the staff
  // panel would break the "what the patient sees" illusion there.
  if (pathname === '/patient') return null;

  if (collapsed) {
    return (
      <aside className="copilot collapsed">
        <button className="copilot-rail" onClick={() => setCollapsed(false)} title="Open copilot (⌘K)">
          <span className="rail-chevron">
            <ChevronLeft size={16} aria-hidden />
          </span>
          <span className="rail-mark">
            <Sparkles size={14} aria-hidden />
          </span>
          <span className="rail-label">COPILOT</span>
          {busy && <span className="rail-busy" />}
        </button>
      </aside>
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
          <button
            className="icon-btn"
            onClick={() => setCollapsed(true)}
            title="Collapse to the right"
            aria-label="Collapse copilot"
          >
            <ChevronRight size={15} aria-hidden />
          </button>
        </div>
      </div>

      <div className="copilot-toolbar">
        {models.length > 0 ? (
          <ModelPicker models={models} value={model} onChange={setModel} disabled={busy} />
        ) : (
          <span className="model-static">keyword router · no LLM key</span>
        )}
        <span className={`copilot-state ${busy ? 'working' : ''}`}>
          <span className="state-dot" />
          {busy ? 'working' : 'ready'}
        </span>
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
                          <TraceEntry
                            key={ti}
                            t={t}
                            onDecision={(d) =>
                              send(d === 'approve' ? 'Approve the appeal draft and send it.' : 'Reject the appeal draft.')
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {m.attachmentName && (
              <div className="msg-attachment">
                <Paperclip size={11} aria-hidden /> {m.attachmentName}
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

      {(attachment || attachError) && (
        <div className="attach-row">
          {attachment && (
            <span className="attach-chip">
              <Paperclip size={12} aria-hidden />
              <span className="attach-name">{attachment.fileName}</span>
              <button onClick={() => setAttachment(null)} title="Remove attachment" aria-label="Remove attachment">
                <X size={12} aria-hidden />
              </button>
            </span>
          )}
          {attachError ? (
            <span className="attach-error">{attachError}</span>
          ) : (
            <span className="attach-note">identifiers are blacked out before this reaches the chat</span>
          )}
        </div>
      )}

      <div className="composer">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            void pickAttachment(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <button
          className={`attach-btn ${attachment ? 'active' : ''}`}
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="Attach a patient document"
          aria-label="Attach a patient document"
        >
          <Paperclip size={15} aria-hidden />
        </button>
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
          placeholder={
            listening ? 'Listening…' : attachment ? 'Add a note, or just send the document…' : 'Ask or tell the back office… (⌘K)'
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy && !listening}
        />
        <button
          className="send-btn"
          onClick={() => send()}
          disabled={busy || (!input.trim() && !attachment)}
          title="Send"
          aria-label="Send message"
        >
          <ArrowUp size={15} strokeWidth={2.4} aria-hidden />
        </button>
      </div>
    </aside>
  );
}
