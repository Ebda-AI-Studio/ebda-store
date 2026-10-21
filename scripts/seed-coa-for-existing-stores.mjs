#!/usr/bin/env node
/**
 * Backfill the retail Chart of Accounts for every existing store
 * that has accountingEnabled=true. Idempotent — re-running is a safe no-op
 * for stores whose system accounts are already seeded.
 *
 * Usage:
 *   node scripts/seed-coa-for-existing-stores.mjs           # DRY-RUN
 *   node scripts/seed-coa-for-existing-stores.mjs --apply   # write
 *
 * Run after deploying the accounting Batch 1 migration. New stores get COA
 * seeded automatically on creation via StoreService.createStore.
 */

import { createPrismaClient } from '@ebda/database';
import { seedCoaForStore } from '../apps/api/dist/services/accounting/account.service.js';

const APPLY = process.argv.includes('--apply');
const prisma = createPrismaClient({ connectionString: process.env.DATABASE_URL ?? '', role: 'owner' });

async function main() {
  const stores = await prisma.store.findMany({
    where: { accountingEnabled: true, deletedAt: null },
    select: { id: true, slug: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${stores.length} stores eligible for COA seed.`);

  let seeded = 0;
  let skipped = 0;

  for (const store of stores) {
    if (!APPLY) {
      const existing = await prisma.account.count({
        where: { storeId: store.id, isSystem: true },
      });
      const action = existing === 27 ? 'skip (already seeded)' : `seed (${27 - existing} missing)`;
      console.log(`  DRY-RUN: ${store.slug.padEnd(40)} → ${action}`);
      continue;
    }

    const beforeCount = await prisma.account.count({
      where: { storeId: store.id, isSystem: true },
    });
    await seedCoaForStore(store.id);
    const afterCount = await prisma.account.count({
      where: { storeId: store.id, isSystem: true },
    });

    if (afterCount > beforeCount) {
      seeded += 1;
      console.log(`  ✓ ${store.slug} (added ${afterCount - beforeCount} accounts)`);
    } else {
      skipped += 1;
      console.log(`  ⊙ ${store.slug} (already seeded)`);
    }
  }

  if (APPLY) {
    console.log(`\nDone: ${seeded} seeded, ${skipped} skipped. Total stores: ${stores.length}.`);
  } else {
    console.log(`\nDRY-RUN complete. Pass --apply to write.`);
  }
}

main()
  .catch(err => {
    console.error('FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
