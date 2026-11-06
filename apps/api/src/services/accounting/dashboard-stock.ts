import { prisma } from '@ebda/database';
import {
  DISABLED_VARIANT_STOCK_VALUE_SQL,
  storeStockValueFils,
} from '../../lib/effective-inventory-sql';
import { storeMoney } from '../../lib/repo-factory';

/**
 * On-hand stock value and the value parked on DISABLED variants (piastres) for the finance dashboard. A store on its Durable
 * Object answers from its own `products` / `product_variants` in one statement (Ruling NZ-FEAT-1); a Postgres store runs the
 * variant-aware raw SQL it always did (`storeStockValueFils` + the issue-2146 disabled-variant line).
 */
export async function dashboardStockValues(
  storeId: string
): Promise<{ stockValue: number; disabledVariantStockValue: number }> {
  const money = await storeMoney(storeId);
  if (money) {
    const r = await money.stockValue();
    return { stockValue: r.value, disabledVariantStockValue: r.disabledValue };
  }
  const [stockValue, disabledValueRows] = await Promise.all([
    storeStockValueFils(storeId),
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(${DISABLED_VARIANT_STOCK_VALUE_SQL}), 0) AS total
      FROM public.products p
      WHERE p.store_id = ${storeId} AND p.deleted_at IS NULL
    `,
  ]);
  return { stockValue, disabledVariantStockValue: Number(disabledValueRows[0]?.total ?? 0) };
}
