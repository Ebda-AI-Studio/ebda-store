// READ-ONLY (spec §5 gate): wadyaljuz's resolved layout must be byte-identical
// before/after Phase 2. palora is logged but NOT gated (adopts minimal baseline).
//   run:  node packages/database/scripts/verify-baseline-nodrift.mjs
import { PrismaClient } from '@prisma/client';
import { resolveLayoutSettings } from '@force/shared';

const prisma = new PrismaClient();

// Recursively sort object keys so the comparison is INSENSITIVE to key order
// (the merge spreads keys in a different order before vs after, but key order
// is irrelevant to rendering — components read by name — and to caching).
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

function deepEqual(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const stores = await prisma.store.findMany({
  // wady-aljuz + pecannbee (id-pinned; slug may change at domain cutover) are
  // LIVE CLIENT STORES — their resolved layout must never drift (2026-07-12).
  where: {
    OR: [
      { slug: { in: ['wady-aljuz', 'palora'] } },
      { id: '359afc1f-ea5b-4f8d-b372-c038c6c057f7' },
    ],
  },
  select: { id: true, slug: true, template: true, layoutSettings: true },
});

let failed = false;
for (const s of stores) {
  const saved = s.layoutSettings ?? {};
  const before = resolveLayoutSettings(saved); // legacy (no templateId)
  const after = resolveLayoutSettings(saved, s.template); // phase 2
  const same = deepEqual(before, after);
  if (s.slug === 'wady-aljuz') {
    console.log(`wady-aljuz [${s.template}] no-drift: ${same ? 'PASS' : 'FAIL'}`);
    if (!same) {
      failed = true;
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
      `palora [${s.template}] adopts baseline (not gated): changed=${!same} (expected: true)`
    );
  }
}

await prisma.$disconnect();
if (failed) {
  console.error('\nFAIL: wadyaljuz layout drifted — do not ship.');
  process.exit(1);
}
console.log('\nPASS: wadyaljuz unchanged.');
