'use client';

import { Paperclip, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { drawRedactedImage, loadAttachment, shrinkForStorage, type ImageAttachment, type PhiBox } from '@/lib/chatImage';

/**
 * Filing a document onto a chart from the front desk.
 *
 * The same two-pass shape the copilot uses: the server reads the image once and
 * says where the identifiers sit, the browser burns the boxes on, and only that
 * redacted copy is ever sent back to be stored. The original bytes never leave
 * this component.
 */

export interface DocumentUploadProps {
  patientId: string;
}

interface Reading {
  documentType: string;
  boxes: PhiBox[];
  fields: string[];
}

export function DocumentUpload({ patientId }: DocumentUploadProps) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<ImageAttachment | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    setIsReading(true);
    try {
      // Staged, not uploaded — a mis-click costs nothing.
      setStaged(await loadAttachment(file));
    } catch (err) {
      console.error('[patients] attachment failed to load:', err);
      setError(err instanceof Error ? err.message : 'That file could not be read.');
    } finally {
      setIsReading(false);
    }
  }

  async function file(): Promise<void> {
    if (!staged) return;
    setIsSaving(true);
    setError(null);
    try {
      const readRes = await fetch('/api/patients/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'read', mediaType: staged.mediaType, base64: staged.base64 }),
      });
      if (!readRes.ok) throw new Error(`document read failed: ${readRes.status}`);
      const reading = (await readRes.json()) as Reading;

      const redacted = await drawRedactedImage(staged.dataUrl, reading.boxes);
      const stored = await shrinkForStorage(redacted);

      const fileRes = await fetch('/api/patients/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'file',
          patientId,
          base64: stored,
          mediaType: 'image/jpeg',
          fileName: staged.fileName,
          documentType: reading.documentType,
          fields: reading.fields,
          boxCount: reading.boxes.length,
        }),
      });
      if (!fileRes.ok) throw new Error(`document filing failed: ${fileRes.status}`);

      setStaged(null);
      startTransition(() => router.refresh());
    } catch (err) {
      console.error('[patients] document upload failed:', err);
      // Keep the staged file so filing can be retried without re-picking.
      setError('Could not file that document.');
    } finally {
      setIsSaving(false);
    }
  }

  const busy = isReading || isSaving;

  return (
    <div className="doc-upload">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          // Re-picking the same file must fire onChange again.
          e.target.value = '';
        }}
      />
      <button
        type="button"
        className={`switch-chip${staged ? ' active' : ''}`}
        onClick={() => fileRef.current?.click()}
        disabled={busy}
      >
        <Upload size={13} strokeWidth={2.2} aria-hidden />
        {isReading ? 'Reading…' : staged ? 'Choose another' : 'Upload a document'}
      </button>

      {staged && (
        <>
          <span className="attach-chip">
            <Paperclip size={12} aria-hidden />
            <span className="attach-name">{staged.fileName}</span>
            <button type="button" onClick={() => setStaged(null)} title="Remove" aria-label="Remove document">
              <X size={12} aria-hidden />
            </button>
          </span>
          <button type="button" className="intake-submit" onClick={() => void file()} disabled={isSaving}>
            {isSaving ? 'Filing…' : 'File on chart'}
          </button>
        </>
      )}

      {error ? (
        <span className="attach-error">{error}</span>
      ) : (
        <span className="attach-note">Identifiers are blacked out before the copy leaves your browser.</span>
      )}
    </div>
  );
}
