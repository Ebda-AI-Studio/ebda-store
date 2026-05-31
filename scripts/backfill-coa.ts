/**
 * One-time Chart-of-Accounts back-fill for existing stores.
 *
 * RUN BY AHMAD ONLY (needs a live DATABASE_URL). The automatic seed only runs
 * at store-create time, so any store that pre-dates that code — or was created
 * via the DB seeder — has zero `account` rows. Without accounts, every
 * journal-posting path (paid orders, expenses, refunds…) throws
 * "System account <code> not found … — seed COA first".
 *
 * `seedCoaForStore` is idempotent: it inserts only the COA_TEMPLATE codes a
 * store is missing, so this script is safe to re-run.
 *
 * Usage (from repo root, with apps/api/.env providing DATABASE_URL + DIRECT_URL):
 *   npx tsx scripts/backfill-coa.ts
 *
 * Alternatively, a super_admin can seed each store from the admin UI button on
 *   /stores/<id>/finance/accounts  → "Seed default accounts"
 * or via the API:
 *   POST /api/v1/stores/<storeId>/finance/accounts/seed
 */
import { prisma } from '@force/database';
import { seedCoaForStore } from '../apps/api/src/services/accounting/account.service';

async function main() {
  const stores = await prisma.store.findMany({ select: { id: true, name: true } });
  let totalCreated = 0;
  for (const store of stores) {
    const created = await seedCoaForStore(store.id);
    totalCreated += created;
    // eslint-disable-next-line no-console
    console.log(`[backfill-coa] ${store.name} (${store.id}): created ${created} account(s)`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[backfill-coa] done — ${stores.length} store(s), ${totalCreated} account(s) created`
  );
}

main()
  .catch(err => {
    // eslint-disable-next-line no-console
    console.error('[backfill-coa] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
