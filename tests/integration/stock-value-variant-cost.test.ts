/**
 * Stock valuation uses each variant's own cost (audit 2026-09-30, finding 2 —
 * the valuation siblings of the order-line cost fix).
 *
 * The finance dashboard, the analytics inventory snapshot and the inventory
 * page all multiplied the variant-aware QUANTITY by the PARENT product's cost,
 * so a variant product was valued at 0 (parent cost empty) or at an unrelated
 * figure — while PO receive now writes the weighted-average cost to the
 * variant. `STOCK_VALUE_SQL` values an ACTIVE variant at
 * `variant.cost_price ?? product.cost_price`, like account.service's opening
 * balance entry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { AnalyticsService } from '../../apps/api/src/services/analytics.service';
import { InventoryService } from '../../apps/api/src/services/inventory.service';
import {
  DISABLED_VARIANT_STOCK_VALUE_SQL,
  STOCK_VALUE_SQL,
} from '../../apps/api/src/lib/effective-inventory-sql';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const OWNER = '00000000-0000-0000-0000-0000000000fa';
let storeId: string;

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `stock-value-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'S',
      lastName: 'V',
    },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = await prisma.store.create({
    data: { name: `stock-value-${suffix}`, slug: `stock-value-${suffix}`, ownerId: OWNER },
  });
  storeId = store.id;
  await prisma.product.create({
    data: {
      storeId,
      name: 'Variant product',
      slug: `sv-variant-${suffix}`,
      price: 3000,
      costPrice: 1500,
      inventory: 0,
      hasVariants: true,
      status: 'active',
      variants: {
        create: [
          { title: 'Own cost', costPrice: 700, inventory: 10 },
          { title: 'Parent cost', costPrice: null, inventory: 5 },
          // Disabled: not stock, not value (#1103).
          { title: 'Disabled', costPrice: 50, inventory: 100, isActive: false },
        ],
      },
    },
  });
  await prisma.product.create({
    data: {
      storeId,
      name: 'Simple product',
      slug: `sv-simple-${suffix}`,
      price: 1000,
      costPrice: 500,
      inventory: 4,
      status: 'active',
    },
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

// 10 × 700 + 5 × 1500 (fallback) + 4 × 500
const EXPECTED = 16500;

describe.skipIf(!hasDb)('stock value is variant-cost aware', () => {
  it('analytics inventory snapshot', async () => {
    const snap = await AnalyticsService.stockSnapshot(storeId);
    expect(snap.stockValue).toBe(EXPECTED);
  });

  it('inventory page stats and per-product rows', async () => {
    const stats = await InventoryService.getStats(storeId);
    expect(stats.totalValue).toBe(EXPECTED);
    const list = await InventoryService.listProducts(storeId, {});
    const byName = new Map(list.products.map(p => [p.name, p.stockValue]));
    expect(byName.get('Variant product')).toBe(14500);
    expect(byName.get('Simple product')).toBe(2000);
  });
});

/**
 * issue 2146 — the disabled variant's value is excluded from stock (M5-6) but
 * must not vanish: the finance dashboard reports it on its own line, from the
 * exact inverse predicate. The two figures partition every variant's value.
 */
describe.skipIf(!hasDb)('value held on disabled variants (issue 2146)', () => {
  it('is 100 × 50 for the disabled variant, and disjoint from stock value', async () => {
    const [row] = await prisma.$queryRaw<Array<{ stock: bigint; disabled: bigint }>>`
      SELECT COALESCE(SUM(${STOCK_VALUE_SQL}), 0) AS stock,
             COALESCE(SUM(${DISABLED_VARIANT_STOCK_VALUE_SQL}), 0) AS disabled
      FROM public.products p
      WHERE p.store_id = ${storeId} AND p.deleted_at IS NULL`;
    expect(Number(row.stock)).toBe(EXPECTED);
    expect(Number(row.disabled)).toBe(100 * 50);
  });
});
