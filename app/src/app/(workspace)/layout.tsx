import type { ReactNode } from 'react';
import { getStore } from '@/lib/medplum.server';
import { mossMode } from '@/lib/moss.server';
import { reasonEngine } from '@/lib/reason';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Copilot } from '@/components/Copilot';
import { Sidebar } from '@/components/Sidebar';

export const dynamic = 'force-dynamic';

/**
 * Workspace shell shared by every page: sidebar (patient-journey nav),
 * topbar (integration status + live refresh), content, and the copilot —
 * which persists across pages so a conversation can span intake → claims.
 */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const store = await getStore();
  const modes: Array<[string, string, boolean]> = [
    ['Medplum', store.mode === 'medplum' ? 'live' : 'demo store', store.mode === 'medplum'],
    ['Moss', mossMode() === 'moss' ? 'live' : 'lexical fallback', mossMode() === 'moss'],
    ['Reason', reasonEngine() === 'anthropic' ? 'claude' : 'template', reasonEngine() === 'anthropic'],
    ['Stedi', process.env.STEDI_API_KEY ? 'live' : 'simulated', Boolean(process.env.STEDI_API_KEY)],
  ];

  return (
    <div className="shell">
      <Sidebar />
      <div className="shell-main">
        <header className="topbar">
          <div className="chips">
            {modes.map(([name, mode, isLive]) => (
              <span key={name} className={`chip ${isLive ? 'chip-live' : ''}`}>
                {name}: <b>{mode}</b>
              </span>
            ))}
          </div>
          <AutoRefresh />
        </header>
        <div className="shell-body">
          <main className="content">{children}</main>
          <Copilot />
        </div>
      </div>
    </div>
  );
}
