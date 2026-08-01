'use client';

import { useState } from 'react';
import type { PatientChart } from '@/lib/chart';
import { DocumentsTab } from './DocumentsTab';
import { FhirTab } from './FhirTab';
import { JourneyTab } from './JourneyTab';
import { SummaryTab } from './SummaryTab';

/**
 * The chart controller: owns which tab you are reading, and nothing else.
 *
 * Tab state is deliberately client-only, for the same reason the calendar's
 * view is — the page re-renders every 4s (AutoRefresh) and again whenever the
 * copilot writes, and a refresh must never move you off what you were reading.
 * Two consequences worth keeping in mind when editing this file: this component
 * must never carry a data-derived `key` (that would remount it on every tick and
 * snap you back to Summary), and only the active panel is mounted, so each tab
 * gets a fresh entrance when you switch to it.
 */

type ChartTab = 'summary' | 'journey' | 'documents' | 'fhir';

const TABS: Array<{ id: ChartTab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'journey', label: 'Journey' },
  { id: 'documents', label: 'Documents' },
  { id: 'fhir', label: 'FHIR' },
];

export interface PatientChartTabsProps {
  chart: PatientChart;
}

export function PatientChartTabs({ chart }: PatientChartTabsProps) {
  const [tab, setTab] = useState<ChartTab>('summary');
  const firstName = chart.demographics.name.split(' ')[0];

  return (
    <>
      <div className="chart-tabs" role="tablist" aria-label={`${chart.demographics.name}'s chart`}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`chart-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`chart-panel-${t.id}`}
            className={`switch-chip${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'documents' && chart.documents.length > 0 && (
              <span className="chart-tab-count">{chart.documents.length}</span>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`chart-panel-${tab}`} aria-labelledby={`chart-tab-${tab}`} tabIndex={0}>
        {tab === 'summary' && <SummaryTab chart={chart} firstName={firstName} />}
        {tab === 'journey' && (
          <JourneyTab patientId={chart.demographics.id} firstName={firstName} events={chart.journey} />
        )}
        {tab === 'documents' && (
          <DocumentsTab patientId={chart.demographics.id} documents={chart.documents} />
        )}
        {tab === 'fhir' && <FhirTab fhir={chart.fhir} />}
      </div>
    </>
  );
}
