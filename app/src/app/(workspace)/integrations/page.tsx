import { ExternalLink } from 'lucide-react';
import { Stagger } from '@/components/anim';
import { IntegrationToggle } from '@/components/IntegrationToggle';
import { listIntegrationStates } from '@/lib/integrationSettings.server';
import { CATEGORY_ORDER, STATUS_LABEL, STATUS_TONE, integrationStatus } from '@/lib/integrations';

export const dynamic = 'force-dynamic';

/**
 * Integrations: the services Medplum can connect this clinic to, and which
 * ones are switched on. Enablement persists as a FHIR Basic resource, so the
 * toggle survives restarts and every flip lands in the audit trail.
 */
export default async function IntegrationsPage() {
  const states = await listIntegrationStates();
  const connected = states.filter((s) => integrationStatus(s.enabled) === 'connected');

  return (
    <>
      <div className="page-head">
        <h1>Integrations</h1>
        <p>
          {connected.length} of {states.length} connected — toggle a service on to let the agents use it. Credentials
          live in the environment; this page records what the clinic has turned on.
        </p>
      </div>

      {CATEGORY_ORDER.map((category) => {
        const inCategory = states.filter((s) => s.integration.category === category);
        if (inCategory.length === 0) return null;

        return (
          <div key={category} className="card">
            <h2>{category}</h2>
            <Stagger>
              <div className="integration-grid">
                {inCategory.map(({ integration, enabled }) => {
                  const status = integrationStatus(enabled);
                  return (
                    <div key={integration.id} className={`integration-card ${enabled ? 'enabled' : ''}`}>
                      <div className="integration-top">
                        <span className="integration-name">{integration.name}</span>
                        {/* Keyed on the stored value so the periodic page refresh resets stale optimistic state. */}
                        <IntegrationToggle
                          key={`${integration.id}-${enabled}`}
                          id={integration.id}
                          name={integration.name}
                          enabled={enabled}
                        />
                      </div>
                      <p className="integration-desc">{integration.description}</p>
                      <div className="integration-foot">
                        <span className={`badge ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
                        {integration.envVars.length > 0 && (
                          <span className="integration-env" title={integration.envVars.join(', ')}>
                            {integration.envVars.join(' · ')}
                          </span>
                        )}
                        <a
                          className="integration-docs"
                          href={integration.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`${integration.name} documentation`}
                        >
                          Docs
                          <ExternalLink size={11} strokeWidth={2.2} aria-hidden />
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Stagger>
          </div>
        );
      })}
    </>
  );
}
