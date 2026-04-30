// Apply the variant-merge proposal to Wady Aljuz.
//
// Reads:  /tmp/wady-variant-groups.json  (clean groups only)
// For every clean group:
//   1. Pick the parent (lowest SKU number = earliest registered).
//   2. Mark parent.hasVariants = true.
//   3. Create a single ProductOption on the parent (Arabic axis label).
//   4. Create one ProductOptionValue per distinct axis value in the
//      group (idempotent on value+optionId).
//   5. Create ProductVariant rows on the parent — one per group
//      member, with title from the member's nameAr, the price /
//      inventory / sku / weight copied from the member, and the
//      first product image as imageUrl.
//   6. Link each ProductVariant to its ProductOptionValue via
//      ProductVariantOption.
//   7. Rewrite OrderItem rows that point at sibling productIds —
//      productId becomes the parent's id, variantId becomes the new
//      variant's id, variantName gets stamped, productName left
//      unchanged (it's a snapshot from order time).
//   8. Soft-delete the sibling products.
//
// Whole pass runs inside a single Prisma $transaction per group so a
// failure on any group leaves the rest intact and rolls back the
// half-merged state.
//
// Multi-axis groups stay untouched — the merchant decides whether to
// configure those as 2-D variant tables in the admin.
//
// Dry-run by default; pass `--apply` to write.
import { prisma } from '@force/database';
import { readFileSync } from 'fs';

const APPLY = process.argv.includes('--apply');

const { groups } = JSON.parse(readFileSync('/tmp/wady-variant-groups.json', 'utf8'));

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`Clean groups to fold: ${groups.length} (${groups.reduce((s, g) => s + g.products.length, 0)} products)`);

// Map axis-key → Arabic option label
const AXIS_LABEL = {
  form: { name: 'Form', nameAr: 'الشكل' },
  color: { name: 'Color', nameAr: 'اللون' },
  size: { name: 'Size', nameAr: 'الحجم' },
  taste: { name: 'Taste', nameAr: 'الطعم' },
  origin: { name: 'Origin', nameAr: 'المنشأ' },
  treatment: { name: 'Treatment', nameAr: 'المعالجة' },
};

// Pick the lowest-numeric-suffix SKU as parent. SKUs look like WJ-<n>;
// the earliest one is most-likely the original entry that should keep
// its productId for OrderItem-history continuity.
function skuRank(sku) {
  if (!sku) return Number.POSITIVE_INFINITY;
  const m = String(sku).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}

let foldedProducts = 0;
let createdVariants = 0;
let rewrittenOrderItems = 0;
let failedGroups = 0;

let skippedSameAxisValue = 0;
for (const g of groups) {
  const sorted = [...g.products].sort((a, b) => skuRank(a.sku) - skuRank(b.sku));
  const parent = sorted[0];
  const siblings = sorted.slice(1);
  const axisKey = g.axis;
  const axisLabel = AXIS_LABEL[axisKey];

  // Guard against axis-value collisions inside a group. If two
  // products map to the same canonical axis value (e.g. كزبره with
  // two "حب" entries at different prices), folding them creates two
  // ProductVariant rows for the same option value — the storefront
  // picker resolves to whichever the lookup returns first, making
  // the other variant unreachable. Skip the whole group; merchant
  // resolves the duplicate manually before re-running.
  const axisValueCounts = {};
  for (const p of g.products) {
    const v = p.meta?.axes?.[axisKey];
    if (v) axisValueCounts[v] = (axisValueCounts[v] || 0) + 1;
  }
  const collisions = Object.entries(axisValueCounts).filter(([, n]) => n > 1);
  if (collisions.length > 0) {
    console.log(
      `\n⚠ SKIP ${g.base} × ${g.products.length} (axis=${axisKey}): duplicate axis values ${collisions
        .map(([v, n]) => `${v}×${n}`)
        .join(', ')}`
    );
    for (const m of g.products) {
      console.log(
        `      ${m.sku?.padEnd(8) || '-'} ${(m.nameAr || m.name).slice(0, 50)}  → ${m.meta?.axes?.[axisKey] ?? '—'}  (${(m.price / 1000).toFixed(3)} KWD)`
      );
    }
    skippedSameAxisValue += 1;
    continue;
  }

  // Reload parent + image URLs FROM DB (the dump may be stale; we
  // need the canonical productId we'll be inserting against).
  const parentRow = await prisma.product.findUnique({
    where: { id: parent.id },
    select: {
      id: true,
      name: true,
      nameAr: true,
      hasVariants: true,
      images: { orderBy: { position: 'asc' }, select: { url: true } },
      // Strip any axis token from the parent's display name so it
      // reads as the generic base ("كزبرة" instead of "كزبرة حب").
    },
  });
  if (!parentRow) {
    console.warn(`  WARN: parent ${parent.id} not found in DB — skipping group "${g.base}"`);
    failedGroups += 1;
    continue;
  }

  console.log(
    `\n→ ${g.base} × ${g.products.length}  axis=${axisKey}  parent=${parent.sku}(${parentRow.nameAr || parentRow.name})`
  );

  if (!APPLY) {
    for (const m of g.products) {
      const role = m.id === parent.id ? 'PARENT' : 'variant';
      const axisVal = m.meta?.axes?.[axisKey] ?? '—';
      console.log(`    ${role.padEnd(7)}  ${m.sku?.padEnd(8) || '-'} ${(m.nameAr || m.name).slice(0, 50)}  → ${axisVal}`);
    }
    foldedProducts += siblings.length;
    createdVariants += g.products.length;
    continue;
  }

  // -------- APPLY for this group, all in one transaction --------
  try {
    await prisma.$transaction(
      async tx => {
        // 1) parent flag
        if (!parentRow.hasVariants) {
          await tx.product.update({
            where: { id: parentRow.id },
            data: { hasVariants: true },
          });
        }

        // 2) the option (idempotent — reuse if it already exists with same name)
        let option = await tx.productOption.findFirst({
          where: { productId: parentRow.id, name: axisLabel.name },
        });
        if (!option) {
          option = await tx.productOption.create({
            data: {
              productId: parentRow.id,
              name: axisLabel.name,
              nameAr: axisLabel.nameAr,
              position: 0,
            },
          });
        }

        // 3) one ProductOptionValue per distinct axis value in the
        //    group (use the canonical value, not the surface form)
        const distinctValues = [...new Set(
          g.products.map(p => p.meta?.axes?.[axisKey]).filter(Boolean)
        )];
        const valueIdByCanonical = new Map();
        for (const [i, val] of distinctValues.entries()) {
          let pov = await tx.productOptionValue.findFirst({
            where: { optionId: option.id, value: val },
          });
          if (!pov) {
            pov = await tx.productOptionValue.create({
              data: {
                optionId: option.id,
                value: val,
                valueAr: val,
                position: i,
              },
            });
          }
          valueIdByCanonical.set(val, pov.id);
        }

        // 4) create one ProductVariant per group member (including the
        //    parent itself — the parent product gets a variant of its
        //    own axis value so the storefront UI shows a uniform
        //    picker).
        for (const m of g.products) {
          const axisVal = m.meta?.axes?.[axisKey];
          // Pull the canonical fresh row so the dump's stale fields
          // don't override admin edits made after the snapshot.
          const memberRow = await tx.product.findUnique({
            where: { id: m.id },
            select: {
              id: true,
              name: true,
              nameAr: true,
              sku: true,
              price: true,
              compareAtPrice: true,
              costPrice: true,
              inventory: true,
              weight: true,
              barcode: true,
              images: { orderBy: { position: 'asc' }, select: { url: true } },
            },
          });
          if (!memberRow) continue;
          const variantTitleAr =
            (memberRow.nameAr ?? memberRow.name ?? '').trim() ||
            `${parentRow.name} ${axisVal ?? ''}`.trim();
          const variantTitle =
            (memberRow.name ?? memberRow.nameAr ?? '').trim() || variantTitleAr;

          const created = await tx.productVariant.create({
            data: {
              productId: parentRow.id,
              title: variantTitle,
              titleAr: variantTitleAr,
              sku: memberRow.sku ?? null,
              barcode: memberRow.barcode ?? null,
              price: memberRow.price ?? null,
              compareAtPrice: memberRow.compareAtPrice ?? null,
              costPrice: memberRow.costPrice ?? null,
              inventory: memberRow.inventory ?? 0,
              weight: memberRow.weight ?? null,
              imageUrl: memberRow.images[0]?.url ?? null,
              isActive: true,
            },
          });
          if (axisVal && valueIdByCanonical.has(axisVal)) {
            await tx.productVariantOption.create({
              data: {
                variantId: created.id,
                valueId: valueIdByCanonical.get(axisVal),
              },
            });
          }

          // 5) for siblings only: rewrite OrderItem refs + soft-delete.
          //    Parent's own OrderItem rows can stay pointing at parent
          //    productId with variantId=null OR be backfilled to its
          //    new variant. We backfill so historical reporting can
          //    still see the variant axis.
          await tx.orderItem.updateMany({
            where: { productId: m.id, variantId: null },
            data: {
              productId: parentRow.id,
              variantId: created.id,
              variantName: variantTitleAr,
            },
          });
          rewrittenOrderItems += 1; // upper bound; updateMany doesn't return count synchronously inside the tx return type without await on the result

          if (m.id !== parentRow.id) {
            // Move any wishlist references too — same productId
            // rewrite, no variantId to set on wishlistItem.
            await tx.wishlistItem.updateMany({
              where: { productId: m.id },
              data: { productId: parentRow.id },
            });
            // Cart items currently pointing at the sibling get the
            // same rewrite (variantId stamp included).
            await tx.cartItem.updateMany({
              where: { productId: m.id, variantId: null },
              data: { productId: parentRow.id, variantId: created.id },
            });
            // Soft-delete the sibling product. Hard delete would
            // cascade away ProductImage / ProductCategory; we want to
            // keep those off the active product list but still
            // resolvable for any audit reporting.
            await tx.product.update({
              where: { id: m.id },
              data: { deletedAt: new Date() },
            });
            foldedProducts += 1;
          }
          createdVariants += 1;
        }
      },
      { timeout: 30_000 }
    );
    console.log(`    ✓ folded ${siblings.length} siblings + ${g.products.length} variants created`);
  } catch (err) {
    console.error(`    ✗ failed: ${err.message}`);
    failedGroups += 1;
  }
}

console.log(
  `\nSummary: ${groups.length} groups proposed, ${skippedSameAxisValue} skipped ` +
    `(duplicate axis values), ${foldedProducts} products folded, ` +
    `${createdVariants} variants created, ${failedGroups} group(s) failed.`
);

await prisma.$disconnect();
if (!APPLY) console.log(`\nDRY RUN — pass --apply to write.`);
