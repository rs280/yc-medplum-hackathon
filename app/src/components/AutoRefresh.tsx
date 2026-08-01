'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isLiveRefreshSuspended } from '@/lib/liveRefresh';

export function AutoRefresh({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [tick, setTick] = useState<string>('');

  useEffect(() => {
    const id = setInterval(() => {
      // Never refresh mid-drag — the array would change under the gesture.
      if (isLiveRefreshSuspended()) return;
      router.refresh();
      setTick(new Date().toLocaleTimeString());
    }, intervalMs);
    setTick(new Date().toLocaleTimeString());
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return (
    <span className="live" title="Dashboard refreshes automatically">
      <span className="dot" />
      live · {tick}
    </span>
  );
}
