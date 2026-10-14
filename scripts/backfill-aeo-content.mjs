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
//      howto_aeo, meta_aeo) — required because Inngest handlers guard
//      on jobId presence and update the row for progress tracking.
//   2. Fires the matching Inngest event via the REST API.
//   3. Throttles 3s between stores to smooth Gemini's RPM cap.
//
// Each store generates ~10 Gemini calls (8 FAQs + 3 HowTo + ~product-count
// meta items). With ~5 active stores that is well under the 1000/day cap.
// The AI smart-skip (manuallyEdited guard) means already-filled fields are
// never overwritten — safe to re-run if a store was partially backfilled.
//
// NOT yet run with --apply — left for Ahmad to fire when ready.

import 'dotenv/config';
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
const inngestEventKey = process.env.INNGEST_EVENT_KEY;
if (!inngestEventKey) {
  console.error('✗ INNGEST_EVENT_KEY not set — cannot fire events without an event key.');
  console.error('  Make sure you are running from apps/api/ and .env is present.');
  await prisma.$disconnect();
  process.exit(1);
}

// Inngest Cloud REST endpoint for sending events.
// In dev (no event key), the SDK uses the local DevServer — but for a
// script we send directly via HTTP either way.
const inngestUrl = `https://inn.gs/e/${inngestEventKey}`;

async function fireInngestEvent(name, data) {
  const res = await fetch(inngestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data, ts: Date.now() }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`Inngest HTTP ${res.status}: ${body}`);
  }
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
    await fireInngestEvent('bulk-ai/faq-aeo-requested', {
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
    await fireInngestEvent('bulk-ai/howto-aeo-requested', {
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
    await fireInngestEvent('bulk-ai/meta-aeo-requested', {
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

  // Throttle between stores so Inngest's queue + Gemini's RPM cap are not
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
  console.log('\nInspect progress in the Inngest dashboard or via:');
  console.log(
    `  node -e "const {prisma}=await import('@ebda/database'); console.log(JSON.stringify(await prisma.bulkAiJob.findMany({where:{status:'running'},select:{id:true,kind:true,storeId:true,processed:true,total:true},take:20}),null,2)); await prisma.$disconnect()"`
  );
}

await prisma.$disconnect();
