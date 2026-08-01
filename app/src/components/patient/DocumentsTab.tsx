import { Bot, FileText } from 'lucide-react';
import { Stagger } from '@/components/anim';
import { fmtWhen, type ChartDocument } from '@/lib/chart';
import { DocumentUpload } from './DocumentUpload';

/** Everything on file for this patient: agent-written packets and front-desk uploads. */

export interface DocumentsTabProps {
  patientId: string;
  documents: ChartDocument[];
}

export function DocumentsTab({ patientId, documents }: DocumentsTabProps) {
  return (
    <div className="card">
      <h2>Documents</h2>
      <DocumentUpload patientId={patientId} />
      {documents.length === 0 ? (
        <p className="empty">
          Nothing on file yet — upload an insurance card or referral, or let an agent file a packet here.
        </p>
      ) : (
        <Stagger signal={`${patientId}:${documents.length}`}>
          <div className="doc-list">
            {documents.map((d) => {
              const isAgent = d.origin === 'agent';
              return (
                <div key={d.id} className="doc-row">
                  <span className={`doc-icon${isAgent ? ' is-agent' : ''}`}>
                    {isAgent ? (
                      <Bot size={15} strokeWidth={2} aria-hidden />
                    ) : (
                      <FileText size={15} strokeWidth={2} aria-hidden />
                    )}
                  </span>
                  <div className="doc-body">
                    <a className="doc-title" href={d.contentUrl} target="_blank" rel="noreferrer">
                      {d.title}
                    </a>
                    <div className="patient-meta">
                      {d.createdAt && <span>{fmtWhen(d.createdAt)}</span>}
                      {d.sizeLabel && <span>{d.sizeLabel}</span>}
                      {d.redactedRegions != null && d.redactedRegions > 0 && (
                        <span>{d.redactedRegions} region(s) redacted</span>
                      )}
                    </div>
                    {d.fields && d.fields.length > 0 && (
                      <div className="patient-meta">
                        {d.fields.map((f) => (
                          <span key={f}>{f}</span>
                        ))}
                      </div>
                    )}
                    {d.text && <pre className="artifact">{d.text}</pre>}
                  </div>
                  <span className={`badge tone-${isAgent ? 'accent' : 'neutral'}`}>
                    {isAgent ? 'agent' : 'uploaded'}
                  </span>
                </div>
              );
            })}
          </div>
        </Stagger>
      )}
    </div>
  );
}
