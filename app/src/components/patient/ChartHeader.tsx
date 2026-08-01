import type { PatientChart } from '@/lib/chart';
import { initials } from '@/lib/chart';

/**
 * The identity card above the chart's tabs — the page's old hero card, now
 * driven by whoever is selected instead of a hardcoded MRN.
 */

export interface ChartHeaderProps {
  chart: PatientChart;
}

export function ChartHeader({ chart }: ChartHeaderProps) {
  const { demographics, coverage, journey } = chart;
  const automated = journey.filter((e) => e.kind === 'agent' || e.kind === 'appointment').length;

  return (
    <div className="card patient-card">
      <div className="patient-id">
        <span className="avatar" aria-hidden>
          {initials(demographics.name)}
        </span>
        <div>
          <div className="patient-name">{demographics.name}</div>
          <div className="patient-meta">
            {demographics.mrn && <span>MRN {demographics.mrn}</span>}
            {demographics.dob && <span>DOB {demographics.dob}</span>}
            {demographics.ageYears != null && <span>{demographics.ageYears} yrs</span>}
            {demographics.phone && <span>{demographics.phone}</span>}
          </div>
        </div>
      </div>
      <div className="patient-coverage">
        <div className="label">Coverage</div>
        <div className="patient-payer">{coverage?.payer ?? 'Self-pay'}</div>
        {coverage?.memberId && <div className="patient-meta">Member {coverage.memberId}</div>}
      </div>
      <div className="patient-coverage">
        <div className="label">Agent activity</div>
        <div className="patient-payer">{automated} automated event(s)</div>
        <div className="patient-meta">{journey.length} total on record</div>
      </div>
    </div>
  );
}
