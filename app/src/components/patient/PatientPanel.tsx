import Link from 'next/link';
import { Stagger } from '@/components/anim';
import { initials } from '@/lib/chart';
import type { PatientSummary } from '@/lib/workspace.server';
import { NewPatientForm } from './NewPatientForm';

/**
 * The whole panel, on top. Every card is a link that opens that patient's chart
 * below it, so selection is a URL change the 4s refresh preserves rather than
 * client state it could reset.
 */

export interface PatientPanelProps {
  patients: PatientSummary[];
  /** Highlights the open chart; undefined when nothing is selected. */
  selectedId?: string;
}

export function PatientPanel({ patients, selectedId }: PatientPanelProps) {
  return (
    <div className="card">
      <div className="panel-head">
        <h2>Panel · {patients.length}</h2>
        <NewPatientForm />
      </div>

      {patients.length === 0 ? (
        <p className="empty">
          No patients yet — run <code>npm run seed</code> and <code>npm run seed:synthea</code>, or add one above.
        </p>
      ) : (
        <Stagger signal={patients.length}>
          <div className="roster">
            {patients.map((p) => {
              const isSelected = p.id === selectedId;
              return (
                <Link
                  key={p.id}
                  href={`/patients?p=${p.id}`}
                  // The panel sits at the top, so scroll restoration on every
                  // selection would yank the card out from under the cursor.
                  scroll={false}
                  className={`roster-card${isSelected ? ' is-selected' : ''}`}
                  aria-current={isSelected ? 'page' : undefined}
                  aria-label={`Open the chart for ${p.name}${p.mrn ? `, ${p.mrn}` : ''} — ${p.payer ?? 'Self-pay'}`}
                >
                  <span className="avatar avatar-sm" aria-hidden>
                    {initials(p.name)}
                  </span>
                  <div className="roster-body">
                    <div className="roster-name">{p.name}</div>
                    <div className="patient-meta">
                      {p.mrn && <span>{p.mrn}</span>}
                      {p.dob && <span>DOB {p.dob}</span>}
                    </div>
                    <div className="roster-payer">{p.payer ?? 'Self-pay'}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </Stagger>
      )}
    </div>
  );
}
