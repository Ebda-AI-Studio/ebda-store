/**
 * Verify Wady Aljuz backorder feature state — 2026-05-28
 *
 * Checks the resolved inventory.backorder flag for Wady Aljuz and
 * optionally clears the disable-override so it falls back to the
 * professional plan baseline (which includes inventory.backorder).
 *
 * Usage:
 *   node scripts/verify-wady-aljuz-backorder.mjs          # check only
 *   node scripts/verify-wady-aljuz-backorder.mjs --fix    # clear override + re-verify
 *
 * Requires DATABASE_URL env var (reads from apps/api/.env if not set).
 */

import { createPrismaClient } from '@force/database';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env if DATABASE_URL not set
if (!process.env.DATABASE_URL) {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api', '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
    }
  }
}

const prisma = createPrismaClient({ connectionString: process.env.DATABASE_URL ?? '' });
const STORE_SLUG = 'wadyaljuz';
const FEATURE_KEY = 'inventory.backorder';

// Professional plan baseline includes inventory.backorder
const PROFESSIONAL_BASELINE_INCLUDES_BACKORDER = true;

async function main() {
  const fix = process.argv.includes('--fix');

  const store = await prisma.store.findFirst({
    where: { slug: STORE_SLUG },
    select: { id: true, name: true, slug: true, plan: true },
  });

  if (!store) {
    console.error(`ERROR: store with slug '${STORE_SLUG}' not found`);
    process.exit(1);
  }

  console.log(`Store: ${store.name} (${store.slug})`);
  console.log(`Plan: ${store.plan}`);

  const inBaseline =
    store.plan === 'professional' || store.plan === 'enterprise'
      ? PROFESSIONAL_BASELINE_INCLUDES_BACKORDER
      : false;
  console.log(`Plan baseline includes '${FEATURE_KEY}': ${inBaseline}`);

  const overrideRow = await prisma.storeFeature.findUnique({
    where: { storeId_featureKey: { storeId: store.id, featureKey: FEATURE_KEY } },
    select: { enabled: true, enabledAt: true },
  });

  if (overrideRow) {
    console.log(`Override row: enabled=${overrideRow.enabled} (updated ${overrideRow.enabledAt})`);
  } else {
    console.log(`Override row: NONE (falls back to plan baseline)`);
  }

  const resolved = overrideRow !== null ? overrideRow.enabled : inBaseline;
  console.log(`\nResolved isFeatureEnabled('${STORE_SLUG}', '${FEATURE_KEY}'): ${resolved}`);

  if (!resolved && fix) {
    console.log(`\n--fix: clearing override row...`);
    await prisma.storeFeature
      .delete({ where: { storeId_featureKey: { storeId: store.id, featureKey: FEATURE_KEY } } })
      .catch(() => {});

    const afterRow = await prisma.storeFeature.findUnique({
      where: { storeId_featureKey: { storeId: store.id, featureKey: FEATURE_KEY } },
    });
    const resolvedAfter = afterRow !== null ? afterRow.enabled : inBaseline;
    console.log(`Post-fix resolved value: ${resolvedAfter}`);
    if (!resolvedAfter) {
      console.error(`ERROR: still false after fix. Plan baseline: ${inBaseline}`);
      process.exit(1);
    }
    console.log(`\nOK: Wady Aljuz backorder = ENABLED (plan baseline)`);
  } else if (!resolved) {
    console.warn(`\nWARNING: Wady Aljuz has backorder DISABLED.`);
    console.warn(`  Run with --fix to clear the override, or clear it via super-admin UI.`);
    process.exit(1);
  } else {
    console.log(`\nOK: Wady Aljuz backorder flag = ENABLED`);
    console.log(
      `  Source: ${overrideRow ? `override row (enabled=${overrideRow.enabled})` : `${store.plan} plan baseline`}`
    );
  }
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
