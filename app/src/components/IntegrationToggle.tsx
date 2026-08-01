'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * The on/off switch on an integration card. Optimistic: it flips immediately,
 * then refreshes the server-rendered page so the status pill reflects what
 * Medplum actually stored — and reverts if the write failed.
 */
export function IntegrationToggle({
  id,
  name,
  enabled,
}: {
  id: string;
  name: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [optimistic, setOptimistic] = useState(enabled);
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  async function toggle(): Promise<void> {
    const next = !optimistic;
    setOptimistic(next);
    setFailed(false);
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled: next }),
      });
      if (!res.ok) throw new Error(`toggle failed: ${res.status}`);
      startTransition(() => router.refresh());
    } catch (err) {
      console.error('[integrations] toggle failed:', err);
      setOptimistic(!next);
      setFailed(true);
    }
  }

  return (
    <div className="integration-switch-wrap">
      <button
        type="button"
        role="switch"
        aria-checked={optimistic}
        aria-label={`${optimistic ? 'Disable' : 'Enable'} ${name}`}
        className={`integration-switch ${optimistic ? 'on' : ''} ${isPending ? 'pending' : ''}`}
        onClick={toggle}
      >
        <span className="integration-switch-knob" />
      </button>
      {failed && <span className="integration-switch-error">didn’t save</span>}
    </div>
  );
}
