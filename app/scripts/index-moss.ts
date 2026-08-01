/**
 * Load the retrieval corpus into Moss at boot: payer criteria, LCD/NCD
 * snippets, SOPs (payer-criteria index) and denial-reason playbooks
 * (denial-playbooks index). Also re-indexes any LEARNED playbook entries from
 * Medplum so a fresh boot keeps its lessons. Idempotent (upsert).
 */
import { CRITERIA_DOCS, PLAYBOOK_SEED_DOCS } from '@/lib/corpus';
import { getStore } from '@/lib/medplum.server';
import { loadPlaybook, reindexPlaybook } from '@/lib/memory/playbook';
import { CRITERIA_INDEX, PLAYBOOK_INDEX, mossMode, mossUpsert } from '@/lib/moss.server';

async function main(): Promise<void> {
  console.log(`[index-moss] mode: ${mossMode()}`);
  await mossUpsert(CRITERIA_INDEX, CRITERIA_DOCS);
  console.log(`+ ${CRITERIA_INDEX}: ${CRITERIA_DOCS.length} docs (criteria, LCD/NCD, protocols)`);
  await mossUpsert(PLAYBOOK_INDEX, PLAYBOOK_SEED_DOCS);
  console.log(`+ ${PLAYBOOK_INDEX}: ${PLAYBOOK_SEED_DOCS.length} seed playbooks/SOPs`);

  const store = await getStore();
  const learned = await loadPlaybook(store);
  for (const entry of learned) {
    await reindexPlaybook(entry);
  }
  console.log(`+ ${PLAYBOOK_INDEX}: ${learned.length} learned entr${learned.length === 1 ? 'y' : 'ies'} re-indexed`);
  if (mossMode() === 'fallback') {
    console.log('[index-moss] MOSS_PROJECT_ID/MOSS_API_KEY not set — the app serves these docs from its built-in lexical index.');
  }
  console.log('[index-moss] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
