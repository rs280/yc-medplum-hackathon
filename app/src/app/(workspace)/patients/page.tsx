import { Stethoscope } from 'lucide-react';
import { ChartHeader } from '@/components/patient/ChartHeader';
import { PatientChartTabs } from '@/components/patient/PatientChartTabs';
import { PatientPanel } from '@/components/patient/PatientPanel';
import { patientChart } from '@/lib/patientChart.server';
import { listPatients } from '@/lib/workspace.server';

export const dynamic = 'force-dynamic';

/**
 * Patients: the whole panel up top, and the selected patient's chart directly
 * below it. Selection rides in ?p= so it survives the refresh tick and can be
 * linked; which tab of the chart you are reading is client state, so a refresh
 * can never move you off it.
 *
 * This is the clinician-side (EHR) authorized view of synthetic data — the
 * redaction guarantee governs what leaves the server to external services, not
 * what a clinician sees about their own patient.
 */
export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const { p } = await searchParams;
  const patients = await listPatients();
  // ?p= takes an id or an MRN; a stale one falls back to the demo hero rather
  // than 404-ing mid-demo, so the page always lands on a real chart.
  const selected =
    (p ? patients.find((pt) => pt.id === p || pt.mrn === p) : undefined) ??
    patients.find((pt) => pt.mrn === 'MRN-001234') ??
    patients[0];
  const chart = selected ? await patientChart(selected.id) : undefined;

  return (
    <>
      <div className="page-head">
        <h1>Patients</h1>
        <p>
          {patients.length} on the panel — realistic synthetic records generated with Synthea. Open a chart; every
          event the agents create lands on it automatically.
        </p>
      </div>

      <PatientPanel patients={patients} selectedId={chart?.demographics.id} />

      {chart ? (
        <>
          <ChartHeader chart={chart} />
          <PatientChartTabs chart={chart} />
        </>
      ) : (
        <div className="card">
          <div className="empty-illustration">
            <Stethoscope size={28} strokeWidth={1.6} aria-hidden />
          </div>
          <p className="empty" style={{ textAlign: 'center' }}>
            Pick a patient above to open their chart — summary, journey, documents, and the raw FHIR record.
          </p>
        </div>
      )}
    </>
  );
}
