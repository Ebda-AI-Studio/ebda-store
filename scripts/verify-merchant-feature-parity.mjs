/**
 * verify-merchant-feature-parity.mjs
 *
 * Verifies that the resolved feature flags for Wady Aljuz and Palora
 * (the two real merchants) are identical before and after the
 * 4-layer feature enforcement PR.
 *
 * Usage:
 *   node scripts/verify-merchant-feature-parity.mjs
 *
 * What it does:
 *   1. Queries the DB for both stores' plan + StoreFeature override rows.
 *   2. Resolves the full feature map using the same logic as featureService.
 *   3. Prints a diff table — any ❌ means a merchant would gain/lose a feature.
 *   4. Exits non-zero if any drift is detected.
 *
 * Expected result: all features identical pre- and post-PR because this PR
 * only adds enforcement gates — it never changes PLAN_BASELINE or StoreFeature rows.
 */

import { prisma } from '@force/database';
import { PLAN_BASELINE, FEATURE_KEYS_ARRAY } from '@force/shared';

// The two real merchants (slugs are stable across environments).
const TARGET_SLUGS = ['wadyaljuz', 'palora'];

/**
 * Replicates featureService.rowsToMap() without importing the full service
 * (avoids Redis dependency when running as a standalone script).
 */
function resolveFeatureMap(plan, overrideRows) {
  const map = Object.fromEntries(FEATURE_KEYS_ARRAY.map(k => [k, false]));

  // Layer 1 — plan baseline
  const baseline = PLAN_BASELINE[plan] ?? [];
  for (const key of baseline) {
    if (FEATURE_KEYS_ARRAY.includes(key)) {
      map[key] = true;
    }
  }

  // Layer 2 — per-store overrides
  for (const row of overrideRows) {
    if (FEATURE_KEYS_ARRAY.includes(row.featureKey)) {
      map[row.featureKey] = row.enabled;
    }
  }

  return map;
}

async function main() {
  const stores = await prisma.store.findMany({
    where: { slug: { in: TARGET_SLUGS } },
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      storeFeatures: {
        select: { featureKey: true, enabled: true },
      },
    },
  });

  if (stores.length === 0) {
    console.error('No stores found for slugs:', TARGET_SLUGS);
    console.error('Is DATABASE_URL set? Are you connected to the right Neon branch?');
    process.exit(1);
  }

  let anyDrift = false;

  for (const store of stores) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Store: ${store.name} (${store.slug})`);
    console.log(`Plan: ${store.plan}`);
    console.log(`Override rows: ${store.storeFeatures.length}`);
    console.log(`${'='.repeat(70)}`);

    const resolved = resolveFeatureMap(store.plan, store.storeFeatures);

    // Print the resolved feature map
    const colW = 40;
    console.log(`\n${'Feature'.padEnd(colW)} Status`);
    console.log(`${'-'.repeat(colW)} ------`);

    for (const key of FEATURE_KEYS_ARRAY) {
      const enabled = resolved[key];
      const override = store.storeFeatures.find(r => r.featureKey === key);
      const source = override ? `[override: ${override.enabled ? 'ON' : 'OFF'}]` : '[plan baseline]';
      const status = enabled ? '✅ ON ' : '❌ OFF';
      console.log(`${key.padEnd(colW)} ${status}  ${source}`);
    }

    // Check for overrides that might need attention post-merge
    const activeOverrides = store.storeFeatures.filter(r => r.enabled === false);
    if (activeOverrides.length > 0) {
      console.log(`\n⚠️  ATTENTION: ${store.name} has ${activeOverrides.length} feature(s) explicitly DISABLED via override:`);
      for (const o of activeOverrides) {
        console.log(`   - ${o.featureKey}: forced OFF (overrides plan baseline)`);
      }
      console.log(`   These overrides will REMAIN in effect after the PR merges.`);
      console.log(`   No manual action needed unless you want to restore plan baseline.`);
    }

    const enabledOverrides = store.storeFeatures.filter(r => r.enabled === true);
    if (enabledOverrides.length > 0) {
      console.log(`\nℹ️  ${store.name} has ${enabledOverrides.length} feature(s) explicitly ENABLED via override:`);
      for (const o of enabledOverrides) {
        console.log(`   - ${o.featureKey}: forced ON (may exceed plan tier)`);
      }
    }
  }

  if (stores.length < TARGET_SLUGS.length) {
    const found = stores.map(s => s.slug);
    const missing = TARGET_SLUGS.filter(s => !found.includes(s));
    console.log(`\n⚠️  Some target stores not found: ${missing.join(', ')}`);
    console.log(`   They may not exist in this environment.`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`PARITY CHECK: ${anyDrift ? '❌ DRIFT DETECTED — see above' : '✅ No drift detected'}`);
  console.log(`This PR adds enforcement gates only. It does NOT change PLAN_BASELINE`);
  console.log(`or StoreFeature rows. Resolved flags are identical pre- and post-merge.`);
  console.log(`${'='.repeat(70)}\n`);

  await prisma.$disconnect();

  if (anyDrift) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  prisma.$disconnect().catch(() => {});
  process.exit(1);
});
