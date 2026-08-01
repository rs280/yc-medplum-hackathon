import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';

/**
 * The one Medplum client for the whole app. When MEDPLUM_CLIENT_ID/SECRET are
 * set, everything reads/writes the real Medplum project. When they are not,
 * a file-backed in-memory store (app/.data/fhir-store.json) implements the
 * same narrow interface so the full demo runs locally — shared between the
 * Next.js server and the CLI scripts.
 */

export interface FhirStore {
  mode: 'medplum' | 'memory';
  create<T extends Resource>(resource: T): Promise<T>;
  read<T extends Resource>(resourceType: T['resourceType'], id: string): Promise<T | undefined>;
  update<T extends Resource>(resource: T): Promise<T>;
  search<T extends Resource>(resourceType: T['resourceType'], params?: Record<string, string>): Promise<T[]>;
}

function isConfigured(): boolean {
  return Boolean(process.env.MEDPLUM_CLIENT_ID && process.env.MEDPLUM_CLIENT_SECRET);
}

const g = globalThis as unknown as {
  __medplumClient?: Promise<MedplumClient>;
  __memoryWarned?: boolean;
};

async function getMedplumClient(): Promise<MedplumClient> {
  g.__medplumClient ??= (async () => {
    const clientId = process.env.MEDPLUM_CLIENT_ID!;
    const clientSecret = process.env.MEDPLUM_CLIENT_SECRET!;
    const client = new MedplumClient({
      baseUrl: process.env.MEDPLUM_BASE_URL || 'https://api.medplum.com/',
      clientId,
      clientSecret,
    });
    await client.startClientLogin(clientId, clientSecret);
    return client;
  })();
  return g.__medplumClient;
}

/** Raw client for scripts that need Medplum-only features (Subscriptions). */
export async function getRawMedplum(): Promise<MedplumClient | null> {
  return isConfigured() ? getMedplumClient() : null;
}

// ── File-backed memory store (demo fallback) ────────────────────────────────

type Db = Record<string, Record<string, Resource>>;
const DB_FILE = path.join(process.cwd(), '.data', 'fhir-store.json');

function loadDb(): Db {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) as Db;
  } catch {
    return {};
  }
}

function saveDb(db: Db): void {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function matches(resource: Resource, params: Record<string, string>): boolean {
  const r = resource as Record<string, any>;
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith('_')) continue;
    switch (key) {
      case 'focus':
        if (r.focus?.reference !== value) return false;
        break;
      case 'subject':
        if (r.subject?.reference !== value) return false;
        break;
      case 'patient':
        if (r.patient?.reference !== value) return false;
        break;
      case 'request':
        if (r.request?.reference !== value) return false;
        break;
      case 'beneficiary':
        if (r.beneficiary?.reference !== value) return false;
        break;
      case 'status':
        if (r.status !== value) return false;
        break;
      case 'code': {
        const codings: Array<{ code?: string }> = r.code?.coding ?? [];
        if (!codings.some((c) => c.code === value)) return false;
        break;
      }
      case 'identifier': {
        const ids: Array<{ value?: string }> = r.identifier ?? [];
        if (!ids.some((i) => i.value === value)) return false;
        break;
      }
      default:
        return false; // unsupported param in memory mode — fail loudly-ish
    }
  }
  return true;
}

const memoryStore: FhirStore = {
  mode: 'memory',
  async create<T extends Resource>(resource: T): Promise<T> {
    const db = loadDb();
    const id = resource.id ?? randomUUID();
    const stored = {
      ...resource,
      id,
      meta: { ...resource.meta, lastUpdated: new Date().toISOString() },
    } as T;
    db[resource.resourceType] ??= {};
    db[resource.resourceType][id] = stored;
    saveDb(db);
    return stored;
  },
  async read<T extends Resource>(resourceType: T['resourceType'], id: string): Promise<T | undefined> {
    const db = loadDb();
    return db[resourceType]?.[id] as T | undefined;
  },
  async update<T extends Resource>(resource: T): Promise<T> {
    if (!resource.id) throw new Error('update requires resource.id');
    const db = loadDb();
    const stored = {
      ...resource,
      meta: { ...resource.meta, lastUpdated: new Date().toISOString() },
    } as T;
    db[resource.resourceType] ??= {};
    db[resource.resourceType][resource.id] = stored;
    saveDb(db);
    return stored;
  },
  async search<T extends Resource>(resourceType: T['resourceType'], params: Record<string, string> = {}): Promise<T[]> {
    const db = loadDb();
    const all = Object.values(db[resourceType] ?? {}) as T[];
    const filtered = all.filter((r) => matches(r, params));
    filtered.sort((a, b) => (b.meta?.lastUpdated ?? '').localeCompare(a.meta?.lastUpdated ?? ''));
    const count = params._count ? Number(params._count) : undefined;
    return count ? filtered.slice(0, count) : filtered;
  },
};

const medplumStore: FhirStore = {
  mode: 'medplum',
  async create<T extends Resource>(resource: T): Promise<T> {
    const client = await getMedplumClient();
    return client.createResource<T>(resource);
  },
  async read<T extends Resource>(resourceType: T['resourceType'], id: string): Promise<T | undefined> {
    const client = await getMedplumClient();
    try {
      return (await client.readResource(resourceType, id)) as T;
    } catch {
      return undefined;
    }
  },
  async update<T extends Resource>(resource: T): Promise<T> {
    const client = await getMedplumClient();
    return client.updateResource<T>(resource);
  },
  async search<T extends Resource>(resourceType: T['resourceType'], params: Record<string, string> = {}): Promise<T[]> {
    const client = await getMedplumClient();
    const result = await client.searchResources(resourceType, params);
    return [...result] as T[];
  },
};

export async function getStore(): Promise<FhirStore> {
  if (isConfigured()) return medplumStore;
  if (!g.__memoryWarned) {
    g.__memoryWarned = true;
    console.warn('[medplum] MEDPLUM_CLIENT_ID/SECRET not set — using file-backed demo store at .data/fhir-store.json');
  }
  return memoryStore;
}

/** Every agent action leaves an AuditEvent — the audit trail is a demo feature. */
export async function writeAudit(
  store: FhirStore,
  opts: { subtype: string; description: string; outcome?: '0' | '8'; entities?: string[] },
): Promise<void> {
  try {
    await store.create({
      resourceType: 'AuditEvent',
      type: { system: 'http://dicom.nema.org/resources/ontology/DCM', code: '110100', display: 'Application Activity' },
      subtype: [{ code: opts.subtype, display: opts.subtype }],
      action: 'E',
      recorded: new Date().toISOString(),
      outcome: opts.outcome ?? '0',
      outcomeDesc: opts.description,
      agent: [{ who: { display: 'autonomous-back-office' }, requestor: false }],
      source: { observer: { display: 'agent-pipeline' } },
      entity: (opts.entities ?? []).map((ref) => ({ what: { reference: ref } })),
    });
  } catch (err) {
    console.warn('[audit] write failed:', err);
  }
}
