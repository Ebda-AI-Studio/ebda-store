#!/usr/bin/env node
// One-off backfill: queues the FAQ/HowTo/conversational-meta AI sweeps
// across every active store so existing tenants catch up to net-new-store
// parity (new stores get these sweeps automatically when admin clicks
// the buttons on /stores/[id]/ai-tools).
//
// Default: dry-run (prints what would happen).
// Apply mode: node scripts/backfill-aeo-content.mjs --apply
//             (run from apps/api/ so @ebda/database resolves)
//
// Optional filter: --store-slug=<slug>  (test one store before going wide)
//
// What it does per store:
//   1. Creates a BulkAiJob row in the DB for each sweep kind (faq_aeo,
//      howto_aeo, meta_aeo) — required because the job handlers guard
//      on jobId presence and update the row for progress tracking.
//   2. Starts the matching job as an `ebda-jobs` Workflow instance (wrangler).
//   3. Throttles 3s between stores to smooth Gemini's RPM cap.
//
// Each store generates ~10 Gemini calls (8 FAQs + 3 HowTo + ~product-count
// meta items). With ~5 active stores that is well under the 1000/day cap.
// The AI smart-skip (manuallyEdited guard) means already-filled fields are
// never overwritten — safe to re-run if a store was partially backfilled.
//
// NOT yet run with --apply — left for Ahmad to fire when ready.

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { prisma } from '@ebda/database';

const apply = process.argv.includes('--apply');
const filterArg = process.argv.find(a => a.startsWith('--store-slug='));
const filterSlug = filterArg?.split('=')[1];

// -----------------------------------------------------------------------
// Load active stores
// -----------------------------------------------------------------------
const where = { status: 'active' };
if (filterSlug) where.slug = filterSlug;

const stores = await prisma.store.findMany({
  where,
  select: { id: true, name: true, slug: true },
  orderBy: { createdAt: 'asc' },
});

console.log(
  `Found ${stores.length} active store(s)${filterSlug ? ` (filtered to slug=${filterSlug})` : ''}\n`
);

if (stores.length === 0) {
  console.log('Nothing to do.');
  await prisma.$disconnect();
  process.exit(0);
}

// -----------------------------------------------------------------------
// Dry-run
// -----------------------------------------------------------------------
if (!apply) {
  console.log('DRY RUN — would queue the following sweeps for each store:');
  console.log('  - bulk-ai/faq-aeo-requested  (creates BulkAiJob kind=faq_aeo,   count=8)');
  console.log('  - bulk-ai/howto-aeo-requested (creates BulkAiJob kind=howto_aeo, count=3)');
  console.log('  - bulk-ai/meta-aeo-requested  (creates BulkAiJob kind=meta_aeo)\n');
  for (const s of stores) {
    console.log(`  → ${s.name} (slug=${s.slug})`);
  }
  console.log('\nRe-run with --apply to fire the sweeps.');
  await prisma.$disconnect();
  process.exit(0);
}

// -----------------------------------------------------------------------
// Apply mode — validate env before touching anything
// -----------------------------------------------------------------------
// The sweeps run as Cloudflare Workflow instances of the `ebda-jobs` Workflow (the same params the API's
// dispatcher uses: { fn, event }). This script starts them with the wrangler CLI, so run it from a
// shell logged in to the Cloudflare account that owns ebda-api (`npx wrangler whoami`).
const JOB_FOR_EVENT = {
  'bulk-ai/faq-aeo-requested': 'bulk-ai-faq-aeo',
  'bulk-ai/howto-aeo-requested': 'bulk-ai-howto-aeo',
  'bulk-ai/meta-aeo-requested': 'bulk-ai-meta-aeo',
};

function fireJobEvent(name, data) {
  const fn = JOB_FOR_EVENT[name];
  if (!fn) throw new Error(`no job for event ${name}`);
  const id = `backfill-${fn}-${data.jobId}`.slice(0, 100);
  const params = JSON.stringify({ fn, event: { name, id, data, ts: Date.now() } });
  execFileSync('npx', ['wrangler', 'workflows', 'trigger', 'ebda-jobs', params, '--id', id], {
    cwd: new URL('../apps/api', import.meta.url).pathname,
    stdio: 'pipe',
  });
}

// -----------------------------------------------------------------------
// Sweep
// -----------------------------------------------------------------------
let succeeded = 0;
let failed = 0;

for (const store of stores) {
  const idx = succeeded + failed + 1;
  console.log(`\n[${idx}/${stores.length}] ${store.name} (slug=${store.slug})`);

  try {
    // --- FAQ sweep ---
    const faqJob = await prisma.bulkAiJob.create({
      data: { storeId: store.id, kind: 'faq_aeo' },
      select: { id: true },
    });
    await fireJobEvent('bulk-ai/faq-aeo-requested', {
      jobId: faqJob.id,
      storeId: store.id,
      count: 8,
    });
    console.log(`  ✓ FAQ sweep queued  (jobId=${faqJob.id})`);

    // --- HowTo sweep ---
    const howtoJob = await prisma.bulkAiJob.create({
      data: { storeId: store.id, kind: 'howto_aeo' },
      select: { id: true },
    });
    await fireJobEvent('bulk-ai/howto-aeo-requested', {
      jobId: howtoJob.id,
      storeId: store.id,
      count: 3,
    });
    console.log(`  ✓ HowTo sweep queued (jobId=${howtoJob.id})`);

    // --- Meta AEO sweep ---
    const metaJob = await prisma.bulkAiJob.create({
      data: { storeId: store.id, kind: 'meta_aeo' },
      select: { id: true },
    });
    await fireJobEvent('bulk-ai/meta-aeo-requested', {
      jobId: metaJob.id,
      storeId: store.id,
    });
    console.log(`  ✓ Meta AEO sweep queued (jobId=${metaJob.id})`);

    succeeded++;
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
    failed++;
    // Continue with remaining stores — one failure should not abort the sweep.
  }

  // Throttle between stores so the jobs queue + Gemini's RPM cap are not
  // overwhelmed by a burst. Handlers themselves throttle per-item at
  // AI_BULK_THROTTLE_MS (default 2.5s), so the queue settles naturally.
  if (idx < stores.length) {
    await new Promise(r => setTimeout(r, 3000));
  }
}

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------
console.log(`\n✓ Done. Queued: ${succeeded} stores, Failed: ${failed} stores.`);
if (succeeded > 0) {
  console.log('\nInspect progress with `npx wrangler workflows instances list ebda-jobs` or via:');
  console.log(
    `  node -e "const {prisma}=await import('@ebda/database'); console.log(JSON.stringify(await prisma.bulkAiJob.findMany({where:{status:'running'},select:{id:true,kind:true,storeId:true,processed:true,total:true},take:20}),null,2)); await prisma.$disconnect()"`
  );
}

await prisma.$disconnect();
