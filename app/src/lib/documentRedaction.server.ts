import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * Step zero for a document a patient hands the front desk: one vision pass
 * that both locates the identifiers to cover and lifts out the handful of
 * fields registration actually needs.
 *
 * The agent loop never receives the image — it works from `fields` as text,
 * while the panel shows only the boxed render — so a photo of an insurance
 * card never becomes a permanent part of the transcript. This mirrors the
 * pipeline's redact step: identify, cover, work from what is left.
 */

/** A region to cover, as 0–1 fractions of image width/height, origin top-left. */
export interface PhiBox {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentFields {
  name?: string;
  birthDate?: string;
  payer?: string;
  memberId?: string;
  groupNumber?: string;
}

export interface DocumentReading {
  documentType: string;
  boxes: PhiBox[];
  fields: DocumentFields;
}

export interface AttachedImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  base64: string;
}

// Ordered so the panel reads like a card: who, then plan, then numbers.
const FIELD_LABELS: Array<[keyof DocumentFields, string]> = [
  ['name', 'name'],
  ['birthDate', 'date of birth'],
  ['payer', 'insurer'],
  ['memberId', 'member ID'],
  ['groupNumber', 'group'],
];

const IDENTIFYING_FIELDS: ReadonlySet<keyof DocumentFields> = new Set(['name', 'birthDate', 'memberId']);

const MAX_BOXES = 40;

const READING_SCHEMA = {
  type: 'object',
  properties: {
    documentType: { type: 'string' },
    boxes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['label', 'x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
    },
    fields: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        birthDate: { type: 'string' },
        payer: { type: 'string' },
        memberId: { type: 'string' },
        groupNumber: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  required: ['documentType', 'boxes', 'fields'],
  additionalProperties: false,
} as const;

const SYSTEM = `You are the redaction pass for a medical clinic's front desk. A patient has handed over a document and it has been photographed. You do two things and nothing else: mark every region that identifies a person, and transcribe the few fields registration needs.

BOX these regions — person names, member/subscriber/policy numbers, group numbers, dates of birth, street addresses, phone numbers, email addresses, social security numbers, medical record numbers, account numbers, barcodes, QR codes, signatures, and photographs of a face. Box the value generously enough to cover every character; a partly visible identifier is not redacted. One box per region, at most ${MAX_BOXES}.

Do NOT box the insurance company name or logo, the plan or product name, coverage tiers, copay amounts, customer service numbers printed for everyone, or generic form text. The front desk needs to see those, and they identify no one.

Coordinates are fractions of the image: x and y are the top-left corner, width and height the size, each between 0 and 1, with the origin at the top-left of the image.

TRANSCRIBE into fields only what you can actually read; omit anything absent or uncertain rather than guessing. birthDate uses YYYY-MM-DD. documentType is a short human label such as "insurance card (front)" or "referral letter".

If the image is not a document — a blank frame, a photo of something else — return an empty boxes array, empty fields, and say so in documentType.`;

function clamp01(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Keep only boxes that describe a real, on-image region. */
function sanitizeBoxes(raw: unknown): PhiBox[] {
  if (!Array.isArray(raw)) return [];
  const boxes: PhiBox[] = [];
  for (const item of raw.slice(0, MAX_BOXES)) {
    const box = item as Partial<PhiBox>;
    const x = clamp01(box.x);
    const y = clamp01(box.y);
    const width = Math.min(clamp01(box.width), 1 - x);
    const height = Math.min(clamp01(box.height), 1 - y);
    if (width <= 0 || height <= 0) continue;
    boxes.push({ label: typeof box.label === 'string' ? box.label : 'identifier', x, y, width, height });
  }
  return boxes;
}

function sanitizeFields(raw: unknown): DocumentFields {
  const input = (raw ?? {}) as Record<string, unknown>;
  const fields: DocumentFields = {};
  for (const [key] of FIELD_LABELS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) fields[key] = value.trim().slice(0, 120);
  }
  return fields;
}

/**
 * Read one attached document. Throws on transport or parse failure — the
 * caller surfaces that as a failed step rather than pretending it read
 * something, since a silent miss here would leave PHI unboxed on screen.
 */
export async function readPatientDocument(
  client: Anthropic,
  model: string,
  image: AttachedImage,
): Promise<DocumentReading> {
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: READING_SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: 'Mark the identifying regions and transcribe the registration fields.' },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('the model declined to read this image');

  // OpenRouter can answer 200 with a provider error in place of a message, so
  // the content array is not guaranteed to exist. Only the error text is
  // logged — a successful body carries the patient's transcribed fields.
  if (!Array.isArray(response.content)) {
    const detail = (response as unknown as { error?: { message?: string } }).error?.message;
    console.warn('[document] vision call returned no content:', detail ?? Object.keys(response).join(', '));
    throw new Error(detail ?? 'the model returned no readable content');
  }

  const text = response.content.find((block) => block.type === 'text')?.text ?? '';
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return {
    documentType: typeof parsed.documentType === 'string' ? parsed.documentType : 'document',
    boxes: sanitizeBoxes(parsed.boxes),
    fields: sanitizeFields(parsed.fields),
  };
}

/** Panel chips: identifiers masked to their last four, since this renders on screen. */
export function describeForPanel(fields: DocumentFields): string[] {
  return FIELD_LABELS.filter(([key]) => fields[key]).map(([key, label]) => {
    const value = fields[key]!;
    return IDENTIFYING_FIELDS.has(key) ? `${label}: ••••${value.slice(-4)}` : `${label}: ${value}`;
  });
}

/**
 * The note appended to the user's turn. Real values, because the front-desk
 * tools need them — the same contract as a patient reading their card aloud.
 */
export function describeForAgent(reading: DocumentReading): string {
  const fields = FIELD_LABELS.filter(([key]) => reading.fields[key]).map(([key, label]) => `${label}: ${reading.fields[key]}`);
  return (
    `[Attached ${reading.documentType} was read by the redaction pass. ` +
    `The copy shown to the user has ${reading.boxes.length} identifying region(s) blacked out; you never see the image itself. ` +
    (fields.length ? `Fields read off it — ${fields.join(', ')}. ` : 'No fields could be read off it. ') +
    `These values are available this turn only and are not kept in the transcript.]`
  );
}
