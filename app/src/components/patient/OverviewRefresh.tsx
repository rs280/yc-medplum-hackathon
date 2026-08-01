'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * The only path in the chart that spends an LLM call. Reading a chart never
 * regenerates the overview — the page re-renders every few seconds, so that has
 * to be a button somebody presses.
 */

export interface OverviewRefreshProps {
  patientId: string;
}

export function OverviewRefresh({ patientId }: OverviewRefreshProps) {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function regenerate(): Promise<void> {
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/patients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate-overview', patientId }),
      });
      if (!res.ok) throw new Error(`overview refresh failed: ${res.status}`);
      startTransition(() => router.refresh());
    } catch (err) {
      console.error('[patients] overview refresh failed:', err);
      setError('Could not refresh the overview.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <button type="button" className="switch-chip" onClick={() => void regenerate()} disabled={isSaving}>
        <RefreshCw size={12} strokeWidth={2.2} aria-hidden />
        {isSaving ? 'Writing…' : 'Refresh'}
      </button>
      {error && <span className="attach-error">{error}</span>}
    </>
  );
}
