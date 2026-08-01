import 'server-only';
import type { DocumentReference, Resource } from '@medplum/fhirtypes';
import type { ChartDocument } from './chart';
import { getStore, writeAudit, type FhirStore } from './medplum.server';
import { PatientError } from './patients.server';

/**
 * Documents on a patient's chart: the packets and letters the agents file, and
 * the cards and referrals handed over at the front desk.
 *
 * The redaction burn-in happens on a canvas in the browser (chatImage.ts) and
 * there is no server-side raster library here, so this module can only ever
 * receive an ALREADY-REDACTED render. That is a strengthening rather than a
 * compromise: the original bytes still exist only inside the vision call and
 * are never written anywhere, exactly as before this feature.
 *
 * Extracted fields are stored MASKED (describeForPanel's "••••6789"). They are
 * already blacked out of the pixels; re-adding them in a sibling field would
 * defeat the burn-in. Real member IDs reach FHIR through Coverage.subscriberId,
 * which is a deliberate write, not a side effect of filing a photo.
 */

const DOC_SOURCE_SYSTEM = 'https://autonomous-backoffice.dev/document-source';
const EXT_FIELDS = 'https://autonomous-backoffice.dev/document-fields';

/** Roughly what the stored base64 weighs, for the chart's size chip. */
function sizeLabel(base64: string | undefined): string | undefined {
  if (!base64) return undefined;
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One bad extension must not blank the whole chart, so this never throws.
function parseFields(raw: string | undefined): { fields?: string[]; boxCount?: number } | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as { fields?: string[]; boxCount?: number };
  } catch {
    return undefined;
  }
}

function originOf(doc: DocumentReference): 'agent' | 'upload' {
  const isUpload = doc.category?.some((c) => c.coding?.some((x) => x.code === 'patient-upload'));
  return isUpload ? 'upload' : 'agent';
}

/**
 * Attachment bytes replaced with the URL that serves them. Applied everywhere a
 * resource reaches the browser: a base64 image inlined into a page that
 * re-renders every few seconds is the fastest way to make this feature feel slow.
 */
export function strippedForDisplay<T extends Resource>(resource: T): T {
  if (resource.resourceType !== 'DocumentReference') return resource;
  const doc = resource as DocumentReference;
  return {
    ...doc,
    content: doc.content?.map((c) => ({
      ...c,
      attachment: c.attachment?.data
        ? { ...c.attachment, data: undefined, url: `/api/patients/documents/${doc.id}` }
        : c.attachment,
    })),
  } as unknown as T;
}

/** Pure: the chart's document rows, newest first. */
export function chartDocumentsFrom(documents: DocumentReference[], maxInlineText: number): ChartDocument[] {
  return documents
    .filter((doc) => doc.id)
    .map((doc) => {
      const attachment = doc.content?.[0]?.attachment;
      const contentType = attachment?.contentType ?? 'application/octet-stream';
      const parsed = parseFields(doc.extension?.find((e) => e.url === EXT_FIELDS)?.valueString);

      // Text artifacts (the prior-auth packet) are small and worth reading in
      // place; images are not, and go behind the URL.
      const text =
        contentType.startsWith('text/') && attachment?.data
          ? Buffer.from(attachment.data, 'base64').toString('utf8').slice(0, maxInlineText)
          : undefined;

      return {
        id: doc.id!,
        title: attachment?.title ?? doc.type?.text ?? doc.description ?? 'Document',
        description: doc.description,
        origin: originOf(doc),
        contentType,
        contentUrl: `/api/patients/documents/${doc.id}`,
        text,
        fields: parsed?.fields,
        redactedRegions: parsed?.boxCount,
        sizeLabel: sizeLabel(attachment?.data),
        createdAt: doc.date ?? doc.meta?.lastUpdated ?? '',
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * File an already-redacted document on a patient's chart. The one place a
 * patient upload becomes a DocumentReference — the copilot's attachment path
 * and the chart's own upload control both land here.
 */
export async function filePatientDocument(opts: {
  patientId: string;
  base64: string;
  mediaType: string;
  fileName: string;
  documentType: string;
  /** Already masked by describeForPanel — never raw values. */
  maskedFields?: string[];
  boxCount?: number;
  store?: FhirStore;
}): Promise<{ id: string; summary: string }> {
  const db = opts.store ?? (await getStore());
  const patient = await db.read('Patient', opts.patientId);
  if (!patient) throw new PatientError('not_found', `No patient with id ${opts.patientId}.`);

  const now = new Date().toISOString();
  const created = await db.create<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    type: { text: opts.documentType },
    // Provenance is a first-class element here, not the meta.tag double-write
    // the calendar needs — Medplum does not strip category.
    category: [{ coding: [{ system: DOC_SOURCE_SYSTEM, code: 'patient-upload' }], text: 'Patient upload' }],
    subject: { reference: `Patient/${opts.patientId}` },
    date: now,
    description: `${opts.documentType} — ${opts.boxCount ?? 0} identifying region(s) redacted`,
    content: [
      {
        attachment: {
          contentType: opts.mediaType,
          data: opts.base64,
          title: opts.fileName,
          creation: now,
        },
      },
    ],
    extension: [
      {
        url: EXT_FIELDS,
        valueString: JSON.stringify({ fields: opts.maskedFields ?? [], boxCount: opts.boxCount ?? 0 }),
      },
    ],
  });

  await writeAudit(db, {
    subtype: 'document-filed',
    description: `${opts.documentType} filed on chart with ${opts.boxCount ?? 0} region(s) redacted`,
    entities: [`Patient/${opts.patientId}`, `DocumentReference/${created.id}`],
  });

  return { id: created.id!, summary: `Filed ${opts.documentType} on the chart.` };
}

/** The stored bytes of one document, for the route that serves them. */
export async function readDocumentBytes(
  documentId: string,
  store?: FhirStore,
): Promise<{ bytes: Buffer; contentType: string } | undefined> {
  const db = store ?? (await getStore());
  const doc = await db.read<DocumentReference>('DocumentReference', documentId);
  const attachment = doc?.content?.[0]?.attachment;
  if (!attachment?.data) return undefined;
  return {
    bytes: Buffer.from(attachment.data, 'base64'),
    contentType: attachment.contentType ?? 'application/octet-stream',
  };
}
