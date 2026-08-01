import type { FhirInventory } from '@/lib/chart';

/**
 * The raw record: exactly what the agents read and write. Related resources are
 * native <details>, which keeps its own open/closed state across the 4s refresh
 * with no JavaScript at all.
 */

export interface FhirTabProps {
  fhir: FhirInventory;
}

export function FhirTab({ fhir }: FhirTabProps) {
  const [patientEntry, ...related] = fhir.entries;
  const summary = Object.entries(fhir.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${n} ${type}`)
    .join(' · ');

  return (
    <div className="card">
      <h2>FHIR record</h2>
      <p className="empty">
        Straight from the store — {summary || 'nothing on record'}. This is what the agents read and write.
      </p>
      {patientEntry && <pre className="artifact">{patientEntry.json}</pre>}
      {related.map((entry) => (
        <details key={entry.reference} className="fhir-block">
          <summary>
            <span className="fhir-type">{entry.resourceType}</span>
            <span className="fhir-id">{entry.reference.split('/')[1]}</span>
            <span>{entry.display}</span>
          </summary>
          <pre className="artifact">{entry.json}</pre>
        </details>
      ))}
    </div>
  );
}
