import 'server-only';
import type { Basic } from '@medplum/fhirtypes';
import { INTEGRATION_CATALOG, type Integration } from './integrations';
import { getStore, writeAudit, type FhirStore } from './medplum.server';

/**
 * Which integrations the clinic has switched on, stored as a single FHIR Basic
 * resource so the setting survives restarts and is readable by bots. One
 * extension per integration (url = catalog id, valueBoolean = enabled), which
 * keeps the resource inspectable in the Medplum admin UI.
 *
 * Credentials are never stored here — they stay in the environment. This
 * resource records intent; `configured` records reality.
 */

const SETTINGS_IDENTIFIER = 'integration-settings';
const IDENTIFIER_SYSTEM = 'https://backoffice.local/settings';
const EXTENSION_BASE = 'https://backoffice.local/integration';

export interface IntegrationState {
  integration: Integration;
  enabled: boolean;
  /** True when every env var the integration needs is present on the server. */
  configured: boolean;
}

function isConfigured(integration: Integration): boolean {
  if (integration.envVars.length === 0) return false;
  return integration.envVars.every((name) => Boolean(process.env[name]));
}

async function findSettingsResource(store: FhirStore): Promise<Basic | undefined> {
  const found = await store.search<Basic>('Basic', { identifier: SETTINGS_IDENTIFIER, _count: '1' });
  return found[0];
}

/** Enabled flags keyed by integration id, falling back to catalog defaults. */
async function readEnabledFlags(store: FhirStore): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {};
  for (const integration of INTEGRATION_CATALOG) {
    flags[integration.id] = integration.defaultEnabled;
  }

  const resource = await findSettingsResource(store);
  for (const ext of resource?.extension ?? []) {
    const id = ext.url?.startsWith(`${EXTENSION_BASE}/`) ? ext.url.slice(EXTENSION_BASE.length + 1) : undefined;
    if (id && typeof ext.valueBoolean === 'boolean') flags[id] = ext.valueBoolean;
  }
  return flags;
}

/** The full catalog with each integration's stored enablement and live credential status. */
export async function listIntegrationStates(): Promise<IntegrationState[]> {
  const store = await getStore();
  const flags = await readEnabledFlags(store);
  return INTEGRATION_CATALOG.map((integration) => ({
    integration,
    enabled: flags[integration.id] ?? integration.defaultEnabled,
    configured: isConfigured(integration),
  }));
}

/** Persist a single toggle, creating the settings resource on first write. */
export async function setIntegrationEnabled(id: string, enabled: boolean): Promise<void> {
  const integration = INTEGRATION_CATALOG.find((entry) => entry.id === id);
  if (!integration) throw new Error(`unknown integration: ${id}`);

  const store = await getStore();
  const flags = await readEnabledFlags(store);
  flags[id] = enabled;

  const extension = INTEGRATION_CATALOG.map((entry) => ({
    url: `${EXTENSION_BASE}/${entry.id}`,
    valueBoolean: flags[entry.id] ?? entry.defaultEnabled,
  }));

  const existing = await findSettingsResource(store);
  const resource: Basic = {
    ...(existing ?? {}),
    resourceType: 'Basic',
    identifier: [{ system: IDENTIFIER_SYSTEM, value: SETTINGS_IDENTIFIER }],
    code: { coding: [{ system: IDENTIFIER_SYSTEM, code: SETTINGS_IDENTIFIER, display: 'Integration settings' }] },
    extension,
  };

  if (existing?.id) {
    await store.update(resource);
  } else {
    await store.create(resource);
  }

  await writeAudit(store, {
    subtype: 'integration-toggle',
    description: `${integration.name} turned ${enabled ? 'on' : 'off'}`,
  });
}
