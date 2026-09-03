/**
 * Repair product slugs that were minted from an empty slugify result.
 *
 * BACKGROUND
 *
 * `ProductService.create` derived its slug with bare `slugify(name)`, which
 * returns '' for a name with no ASCII letters or digits — including a product
 * created before its name was filled in. The de-duplication loop then appended
 * a counter to that empty base, so a store accumulated:
 *
 *     slug ''    <- unreachable: its URL collapses to the product LISTING page
 *     slug '-1', '-2', '-3', '-4'
 *
 * The code defect is fixed (`slugifyWithFallback`), but rows already written
 * stay broken until repaired — this script is that repair.
 *
 * SAFETY
 *
 * - Dry-run by default. Pass `--apply` to write.
 * - Scope with `--store <storeId>`; omit to sweep every store.
 * - Every rename records a SlugRedirect through the same helper the app uses,
 *   so any indexed or shared URL 301s to the new one. (The '' slug has no
 *   meaningful old URL; recordSlugRedirect no-ops on an empty oldSlug.)
 * - New slugs are de-duplicated against the store's existing slugs.
 * - Runs inside a transaction per product so a failure can't half-apply.
 *
 * USAGE
 *   npx tsx scripts/repair-degenerate-product-slugs.ts
 *   npx tsx scripts/repair-degenerate-product-slugs.ts --store <id> --apply
 */
import { prisma, SlugEntityType, withRlsBypass } from '@force/database';
import { slugifyWithFallback } from '@force/shared';
import { recordSlugRedirect } from '../apps/api/src/services/slug-redirect.service';

const APPLY = process.argv.includes('--apply');
const storeArgIdx = process.argv.indexOf('--store');
const STORE_ID = storeArgIdx !== -1 ? process.argv[storeArgIdx + 1] : undefined;

/**
 * A slug is degenerate when it carries no identifying content: empty, or made
 * only of separators/digits ('-1', '--', '2'). Those are never something a
 * merchant chose — they are what the counter produced on an empty base.
 */
function isDegenerate(slug: string): boolean {
  if (!slug || !slug.trim()) return true;
  // Only what the counter produces on an EMPTY base: a leading dash followed
  // by digits ('-1'), or nothing but separators ('--'). A slug of '2024' or
  // '500g' is a legitimate merchant choice and must not be renamed — an
  // over-broad rule here would change working URLs for no reason.
  return /^-\d+$/.test(slug) || /^-+$/.test(slug);
}

async function main() {
  // Candidates exclude soft-deleted rows (no point renaming a deleted product)…
  const products = await withRlsBypass(tx =>
    tx.product.findMany({
      where: { ...(STORE_ID ? { storeId: STORE_ID } : {}), deletedAt: null },
      select: { id: true, storeId: true, slug: true, name: true, nameAr: true },
    })
  );

  // …but the TAKEN set must include them. `@@unique([storeId, slug])` carries no
  // partial predicate, so a soft-deleted product still occupies its slug. Built
  // from the filtered list, the de-duplication loop would hand out a slug the
  // index then rejects with P2002 — mid-sweep, after earlier rows had already
  // committed in their own transactions.
  const allForTaken = await withRlsBypass(tx =>
    tx.product.findMany({
      where: { ...(STORE_ID ? { storeId: STORE_ID } : {}) },
      select: { storeId: true, slug: true },
    })
  );

  const broken = products.filter(p => isDegenerate(p.slug));
  console.log(
    `scanned ${products.length} products${STORE_ID ? ` in store ${STORE_ID}` : ''} — ${broken.length} degenerate slug(s)`
  );
  if (broken.length === 0) return;

  // Slugs already taken, per store, so the replacements de-duplicate correctly.
  const takenByStore = new Map<string, Set<string>>();
  for (const p of allForTaken) {
    if (!takenByStore.has(p.storeId)) takenByStore.set(p.storeId, new Set());
    takenByStore.get(p.storeId)!.add(p.slug);
  }

  let applied = 0;
  let failed = 0;

  for (const p of broken) {
    const taken = takenByStore.get(p.storeId)!;
    // Prefer the English name; fall back to Arabic (slugify keeps Unicode
    // letters now), then to the generated fallback.
    const base = slugifyWithFallback(p.name || p.nameAr || '', 'product');
    let next = base;
    let n = 0;
    while (taken.has(next)) {
      n++;
      next = `${base}-${n}`;
    }

    console.log(
      `  ${p.storeId}  ${JSON.stringify(p.slug)} -> ${JSON.stringify(next)}   (${p.name})`
    );

    if (APPLY) {
      try {
        await withRlsBypass(async tx => {
          await tx.product.update({ where: { id: p.id }, data: { slug: next } });
          await recordSlugRedirect(tx, p.storeId, SlugEntityType.PRODUCT, p.slug, next);
        });
        taken.delete(p.slug);
        taken.add(next);
        applied++;
      } catch (err) {
        // Continue rather than abort. Each product is its own transaction, so a
        // throw here would leave a partially-applied sweep plus a stack trace,
        // and a re-run would stop at the same row.
        failed++;
        console.error(`    FAILED ${p.id}: ${(err as Error).message}`);
      }
    }
  }

  console.log(
    APPLY
      ? `\napplied ${applied} slug repair(s)${failed ? `, ${failed} FAILED (see above)` : ''}.`
      : `\nDRY RUN — nothing written. Re-run with --apply to write.`
  );
  if (failed) process.exitCode = 1;
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
