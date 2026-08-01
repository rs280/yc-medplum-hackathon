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
  ExternalLink,
  Paperclip,
  Quote,
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
import {
  drawRedactedImage,
  loadAttachment,
  shrinkForStorage,
  type ImageAttachment,
  type PhiBox,
} from '@/lib/chatImage';

/**
 * File the redacted copy onto a patient's chart. Fire-and-forget: a failure
 * here must never interrupt the turn, and the note the model already received
 * says the document was filed, so a silent retry is not worth the complexity.
 */
async function fileOnChart(
  patientId: string,
  redactedImage: string,
  fileName: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await fetch('/api/patients/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'file',
        patientId,
        base64: await shrinkForStorage(redactedImage),
        mediaType: 'image/jpeg',
        fileName,
        documentType: typeof data.documentType === 'string' ? data.documentType : 'document',
        fields: Array.isArray(data.fields) ? data.fields : [],
        boxCount: Array.isArray(data.boxes) ? data.boxes.length : 0,
      }),
    });
    if (!res.ok) throw new Error(`filing failed (${res.status})`);
  } catch (err) {
    console.warn('[copilot] could not file the document on the chart:', err);
  }
}
import { collectCitations, type Citation, type RetrievedSource } from '@/lib/citations';
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

/** The model narrating its own reasoning, shown as a step rather than as the answer. */
interface Thought {
  kind: 'thought';
  text: string;
}

/** Thoughts and tool steps share one list so they render in the order they happened. */
type Entry = Thought | ({ kind: 'step' } & Step);

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  entries: Entry[];
  attachmentName?: string;
}

// Written in a clinician's voice, one per capability: read the schedule, move
// a visit, close care gaps, prior auth, appeal a denial, consult the playbook.
const SUGGESTIONS = [
  'What’s on my schedule tomorrow?',
  'Who am I seeing this afternoon?',
  'Any overdue screenings I should close?',
  'Start the prior auth for the MRI',
  'This claim came back denied — appeal it',
  'What usually wins CO-197 denials?',
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

const CITATION_KINDS: Record<Citation['kind'], string> = { moss: 'criteria', pubmed: 'PubMed', named: 'guideline' };

/**
 * Sources behind one reply, collapsed by default. Retrieved ids and named
 * authorities are labelled differently on purpose — one was looked up, the
 * other is the answer telling you where to look.
 */
function Sources({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sources">
      <button className="sources-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Quote size={11} strokeWidth={2.2} aria-hidden />
        Sources
        {citations.length > 0 && <span className="sources-count">{citations.length}</span>}
        <ChevronDown size={11} className={open ? 'sources-caret open' : 'sources-caret'} aria-hidden />
      </button>
      {open && (
        <div className="sources-list">
          {citations.length === 0 ? (
            <p className="sources-empty">
              Nothing retrieved and nothing named — this answer came from the model’s own clinical knowledge.
            </p>
          ) : (
            citations.map((c) => (
              <div key={c.id} className="sources-item">
                <span className={`sources-kind kind-${c.kind}`}>{CITATION_KINDS[c.kind]}</span>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.label}
                    <ExternalLink size={10} aria-hidden />
                  </a>
                ) : (
                  <span>{c.label}</span>
                )}
              </div>
            ))
          )}
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
        ...messagesRef.current.filter((m) => m.text || m.entries.length).map((m) => ({ role: m.role, content: m.text || '(ran tools)' })),
        { role: 'user' as const, content: prompt },
      ];
      setMessages((prev) => [
        ...prev,
        { role: 'user', text: prompt, entries: [], attachmentName: pending?.fileName },
        { role: 'assistant', text: '', entries: [] },
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
            // Whichever chart is open, so an attached document can be filed on
            // it. Read from the URL at send time rather than via a hook, which
            // would put a Suspense boundary around the whole panel.
            patientId:
              typeof window !== 'undefined'
                ? (new URLSearchParams(window.location.search).get('p') ?? undefined)
                : undefined,
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
            } else if (event.type === 'thought') {
              patchAssistant((m) => ({ ...m, entries: [...m.entries, { kind: 'thought', text: event.text }] }));
            } else if (event.type === 'tool') {
              patchAssistant((m) => {
                const entries = [...m.entries];
                const i = entries.findIndex((e) => e.kind === 'step' && e.id === event.id);
                const base = i >= 0 ? (entries[i] as { kind: 'step' } & Step) : null;
                const step: { kind: 'step' } & Step = {
                  kind: 'step',
                  id: event.id,
                  name: event.name,
                  summary: event.summary ?? base?.summary ?? event.name,
                  status: event.status,
                  detail: event.detail,
                  trace: base?.trace ?? [],
                };
                if (i >= 0) entries[i] = step;
                else entries.push(step);
                return { ...m, entries };
              });
              if (event.refresh) router.refresh();
            } else if (event.type === 'pipeline') {
              let data = event.data as Record<string, unknown> | undefined;
              // Boxes arrive as coordinates; the pixels are covered here, against
              // the local original, which is then dropped with `pending`.
              if (event.step === 'redact-document' && pending && Array.isArray(data?.boxes)) {
                try {
                  const redactedImage = await drawRedactedImage(pending.dataUrl, data.boxes as PhiBox[]);
                  data = { ...data, redactedImage };
                  // The redacted copy is the only one that may be kept, and the
                  // browser holds it — so filing happens here, not on the server.
                  const filing = data.filing as { patientId?: string } | null | undefined;
                  if (filing?.patientId) {
                    void fileOnChart(filing.patientId, redactedImage, pending.fileName, data);
                  }
                } catch (err) {
                  console.warn('[copilot] could not render the redacted document:', err);
                }
              }
              patchAssistant((m) => {
                const entries = [...m.entries];
                const i = entries.findIndex((e) => e.kind === 'step' && e.id === event.toolId);
                if (i < 0) return m;
                const step = entries[i] as { kind: 'step' } & Step;
                entries[i] = { ...step, trace: [...step.trace, { step: event.step, detail: event.detail, data }] };
                return { ...m, entries };
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
              Ask in plain language — I read your schedule, move visits, chase prior auths, appeal denials, and run
              patient outreach on the live pipeline. Press <kbd>⌘K</kbd> anytime
              {voiceSupported ? ', or tap the mic and just talk' : ''}.
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
            {m.entries.length > 0 && (
              <div className="steps">
                {m.entries.map((e, ei) =>
                  e.kind === 'thought' ? (
                    <div key={ei} className="thought">
                      <BrainCircuit size={12} strokeWidth={2.1} aria-hidden />
                      <span>{renderRedacted(e.text)}</span>
                    </div>
                  ) : (
                    <div key={e.id} className={`step-block ${e.status}`}>
                      <div className="step">
                        <span className="step-icon">{STEP_ICONS[e.status]}</span>
                        <span className="step-name">{e.name === 'run_agent' ? 'run agent' : e.name.replace(/_/g, ' ')}</span>
                        <span className="step-summary">{e.summary}</span>
                      </div>
                      {/* What the tool actually returned — the patient, the chart, the
                          appointment — shown rather than hidden in a tooltip. */}
                      {e.detail && <div className="step-detail">{renderRedacted(e.detail)}</div>}
                      {e.trace.length > 0 && (
                        <div className="trace">
                          {e.trace.map((t, ti) => (
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
                  ),
                )}
              </div>
            )}
            {m.attachmentName && (
              <div className="msg-attachment">
                <Paperclip size={11} aria-hidden /> {m.attachmentName}
              </div>
            )}
            {m.text && <div className="bubble">{renderRedacted(m.text)}</div>}
            {m.role === 'assistant' && m.text && (
              <Sources
                citations={collectCitations(
                  m.entries.flatMap((e) => (e.kind === 'step' ? e.trace : [])).flatMap((t) => (t.data?.sources as RetrievedSource[]) ?? []),
                  m.text,
                )}
              />
            )}
            {m.role === 'assistant' && !m.text && m.entries.length === 0 && busy && i === messages.length - 1 && (
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
