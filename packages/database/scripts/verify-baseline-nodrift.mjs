// READ-ONLY (spec §5 gate): wady-aljuz's and pecannbee's resolved layouts must
// be byte-identical before/after Phase 2 (#648: pecannbee added to the gate,
// not just the query — see GATED_STORE_IDS below). palora is logged but NOT
// gated (adopts minimal baseline).
//   run:  node packages/database/scripts/verify-baseline-nodrift.mjs
import { PrismaClient } from '@prisma/client';
import { resolveLayoutSettings } from '@force/shared';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Recursively sort object keys so the comparison is INSENSITIVE to key order
// (the merge spreads keys in a different order before vs after, but key order
// is irrelevant to rendering — components read by name — and to caching).
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

export function deepEqual(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// GATED_STORE_IDS pins pecannbee by id (its slug may change at the domain
// cutover — see the query comment); GATED_STORE_SLUGS pins wady-aljuz, whose
// slug is stable. Both LIVE CLIENT STORES' resolved layout must never drift
// (2026-07-12). One predicate drives BOTH the query and the gating decision
// below (#648) so the two can no longer diverge the way they did when
// pecannbee was added to the query but not to the gate: it fell into the
// `else` (not-gated) branch, so `failed` was never set no matter how far its
// layout drifted, and the log mislabelled it "palora" — a resolved-layout
// regression on a live client store would have passed CI silently.
const GATED_STORE_IDS = new Set(['359afc1f-ea5b-4f8d-b372-c038c6c057f7']); // pecannbee
const GATED_STORE_SLUGS = new Set(['wady-aljuz']);
export function isGated(s) {
  return GATED_STORE_SLUGS.has(s.slug) || GATED_STORE_IDS.has(s.id);
}

/**
 * Which pinned stores the query did NOT return (issue 2219). An empty result
 * — a PITR restore onto a branch with different ids, a renamed slug, or the
 * script pointed at a fresh/seed database — used to skip the loop and print
 * PASS having compared nothing. Every pin must resolve, or the run is BROKEN,
 * not clean.
 */
export function missingGatedStores(stores) {
  const missing = [];
  for (const id of GATED_STORE_IDS) {
    if (!stores.some(s => s.id === id)) missing.push(`id ${id}`);
  }
  for (const slug of GATED_STORE_SLUGS) {
    if (!stores.some(s => s.slug === slug)) missing.push(`slug ${slug}`);
  }
  return missing;
}

export const GATED_STORE_COUNT = GATED_STORE_IDS.size + GATED_STORE_SLUGS.size;

// DB access lives behind this guard (not at module load) so the pure
// functions above (canonical/deepEqual/isGated) can be imported and unit
// tested without a live database connection.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main() {
  const prisma = new PrismaClient();
  const stores = await prisma.store.findMany({
    where: {
      OR: [
        { slug: { in: [...GATED_STORE_SLUGS, 'palora'] } },
        { id: { in: [...GATED_STORE_IDS] } },
      ],
    },
    select: { id: true, slug: true, template: true, layoutSettings: true },
  });

  const missing = missingGatedStores(stores);
  if (missing.length > 0) {
    await prisma.$disconnect();
    console.error(
      `\nBROKEN RUN: the gate resolved ${GATED_STORE_COUNT - missing.length} of ${GATED_STORE_COUNT} ` +
        `pinned stores (missing: ${missing.join(', ')}). A pass here would have compared nothing — ` +
        `check DATABASE_URL (a restored branch or seed DB?) and the pinned ids/slugs.`
    );
    process.exit(1);
  }

  let failed = false;
  const failedStores = [];
  for (const s of stores) {
    const saved = s.layoutSettings ?? {};
    const before = resolveLayoutSettings(saved); // legacy (no templateId)
    const after = resolveLayoutSettings(saved, s.template); // phase 2
    const same = deepEqual(before, after);
    if (isGated(s)) {
      console.log(`${s.slug} [${s.template}] no-drift: ${same ? 'PASS' : 'FAIL'}`);
      if (!same) {
        failed = true;
        failedStores.push(s.slug);
        for (const k of Object.keys(after)) {
          if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
            console.error(`  DRIFT at "${k}"`);
            console.error(`    before: ${JSON.stringify(before[k])}`);
            console.error(`    after:  ${JSON.stringify(after[k])}`);
          }
        }
        // keys present in one but not the other
        for (const k of Object.keys(before)) {
          if (!(k in after)) console.error(`  DROPPED key "${k}"`);
        }
        for (const k of Object.keys(after)) {
          if (!(k in before)) console.error(`  ADDED key "${k}"`);
        }
      }
    } else {
      console.log(
        `${s.slug} [${s.template}] adopts baseline (not gated): changed=${!same} (expected: true)`
      );
    }
  }

  await prisma.$disconnect();
  if (failed) {
    console.error(`\nFAIL: ${failedStores.join(', ')} layout drifted — do not ship.`);
    process.exit(1);
  }
  console.log('\nPASS: gated stores unchanged.');
}

if (isMain) {
  await main();
}
