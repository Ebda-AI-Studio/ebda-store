/**
 * Read-only report: purchase-order and backorder lines that name NO variant
 * while their product HAS variants (issues 2345, 2346).
 *
 * Since 2026-10-01 a PO line for a variant product must name its variant
 * (Ruling OD-6a). Lines drafted before that rule:
 *   - cannot be received — `receivePurchaseOrder` refuses them with
 *     `VARIANT_REQUIRED` (the merchant is told to cancel and redraft);
 *   - match no unit in the per-variant reorder scan, so their open quantity is
 *     counted as on order for NO variant.
 * A `partial` PO in this state already received units onto the parent
 * `products.inventory` column, which no stock surface counts. How to settle
 * those units is an owner decision (see issue 2346); this script only says
 * how many exist, per store and PO status, so the transition is measurable.
 *
 *   npx tsx scripts/list-variantless-po-lines.ts            # every store
 *   npx tsx scripts/list-variantless-po-lines.ts --store <slug>
 *
 * Uses DATABASE_URL (the owner role). SELECT only, inside a READ ONLY
 * transaction with the RLS bypass set.
 */
import { prisma } from '@force/database';

export interface VariantlessPoRow {
  storeSlug: string;
  poNumber: string;
  poStatus: string;
  lines: number;
  openQty: number;
  receivedQty: number;
}

export interface VariantlessBackorderRow {
  storeSlug: string;
  openLines: number;
  openQty: number;
}

type RawClient = { $queryRawUnsafe<T>(sql: string, ...v: unknown[]): Promise<T> };

const HAS_VARIANTS = (alias: string) =>
  `EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = ${alias}.product_id)`;

export async function findVariantlessLines(
  db: RawClient,
  storeSlug: string | null
): Promise<{ po: VariantlessPoRow[]; backorders: VariantlessBackorderRow[] }> {
  const po = await db.$queryRawUnsafe<VariantlessPoRow[]>(
    `SELECT s.slug AS "storeSlug", p.po_number AS "poNumber", p.status::text AS "poStatus",
            COUNT(*)::int AS lines,
            COALESCE(SUM(GREATEST(i.qty - i.qty_received, 0)), 0)::int AS "openQty",
            COALESCE(SUM(i.qty_received), 0)::int AS "receivedQty"
       FROM purchase_order_items i
       JOIN purchase_orders p ON p.id = i.po_id
       JOIN stores s ON s.id = p.store_id
      WHERE i.variant_id IS NULL
        AND ${HAS_VARIANTS('i')}
        AND ($1::text IS NULL OR s.slug = $1::text)
      GROUP BY s.slug, p.po_number, p.status
      ORDER BY s.slug, p.status, p.po_number`,
    storeSlug
  );
  const backorders = await db.$queryRawUnsafe<VariantlessBackorderRow[]>(
    `SELECT s.slug AS "storeSlug", COUNT(*)::int AS "openLines",
            COALESCE(SUM(GREATEST(b.qty - b.qty_fulfilled, 0)), 0)::int AS "openQty"
       FROM backorder_lines b
       JOIN stores s ON s.id = b.store_id
      WHERE b.variant_id IS NULL
        AND b.fulfilled_at IS NULL
        AND b.cancelled_at IS NULL
        AND ${HAS_VARIANTS('b')}
        AND ($1::text IS NULL OR s.slug = $1::text)
      GROUP BY s.slug
      ORDER BY s.slug`,
    storeSlug
  );
  return { po, backorders };
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--store');
  const slug = i >= 0 ? (process.argv[i + 1] ?? null) : null;
  const res = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'true'`);
    await tx.$executeRawUnsafe(`SET LOCAL app.current_store_id = ''`);
    return findVariantlessLines(tx as unknown as RawClient, slug);
  });
  if (res.po.length === 0)
    console.log('purchase orders: no variant-less lines on variant products');
  else {
    console.log('purchase orders — variant-less lines on variant products:');
    for (const r of res.po) {
      console.log(
        `  ${r.storeSlug}  ${r.poNumber}  ${r.poStatus.padEnd(9)} lines ${r.lines}  open ${r.openQty}  received ${r.receivedQty}${r.poStatus === 'partial' ? '  ← received units sit on the parent column (not stock)' : ''}`
      );
    }
  }
  if (res.backorders.length === 0) console.log('backorders: none open without a variant');
  else {
    console.log('backorders — open lines without a variant on variant products:');
    for (const r of res.backorders) {
      console.log(`  ${r.storeSlug}  lines ${r.openLines}  open qty ${r.openQty}`);
    }
  }
}

if (process.argv[1] && /list-variantless-po-lines\.ts$/.test(process.argv[1])) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async err => {
      console.error(err instanceof Error ? err.message : err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
