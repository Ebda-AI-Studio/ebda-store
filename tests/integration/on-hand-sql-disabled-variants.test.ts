/**
 * #1103 — `ON_HAND_SQL`, the SQL twin of `effectiveInventory`, applies the same
 * variant rule: a disabled variant is not stock, and a product whose variants
 * are all disabled has 0. Every inventory, analytics, low-stock and finance
 * query that filters or values stock goes through it, so it must agree with
 * the TS helper case for case.
 *
 * Runs the real fragment against real Postgres. The variant rows are written
 * inside a transaction that is always rolled back, with FK triggers off so no
 * store/product fixture is needed.
 */
import { describe, it, expect } from 'vitest';
import { prisma, Prisma } from '@force/database';
import { ON_HAND_SQL } from '@api/lib/effective-inventory-sql';
import { effectiveInventory } from '@api/lib/effective-inventory';

const ROLLBACK = new Error('rollback');

type Variant = { inventory: number; isActive: boolean };
const CASES: Array<{ name: string; parent: number; variants: Variant[]; expected: number }> = [
  { name: 'no variants → parent column', parent: 9, variants: [], expected: 9 },
  {
    name: 'active + disabled → active only',
    parent: 0,
    variants: [
      { inventory: 3, isActive: true },
      { inventory: 50, isActive: false },
    ],
    expected: 3,
  },
  {
    name: 'all disabled → 0, not the parent',
    parent: 7,
    variants: [{ inventory: 50, isActive: false }],
    expected: 0,
  },
  {
    name: 'drifted parent never leaks',
    parent: -16,
    variants: [{ inventory: 11, isActive: true }],
    expected: 11,
  },
];

async function onHandFor(parent: number, variants: Variant[]): Promise<number> {
  let result = NaN;
  const productId = `m5-onhand-${Math.random().toString(36).slice(2)}`;
  await prisma
    .$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      for (const [i, v] of variants.entries()) {
        await tx.$executeRaw`
          INSERT INTO product_variants (id, product_id, title, inventory, is_active, updated_at)
          VALUES (${`${productId}-v${i}`}, ${productId}, 'v', ${v.inventory}, ${v.isActive}, now())`;
      }
      const rows = await tx.$queryRaw<Array<{ on_hand: number }>>(
        Prisma.sql`SELECT (${ON_HAND_SQL})::int AS on_hand
                   FROM (VALUES (${productId}, ${parent}::int)) AS p(id, inventory)`
      );
      result = Number(rows[0].on_hand);
      throw ROLLBACK;
    })
    .catch(err => {
      if (err !== ROLLBACK) throw err;
    });
  return result;
}

describe('ON_HAND_SQL agrees with effectiveInventory on disabled variants (#1103)', () => {
  it.each(CASES)('$name', async ({ parent, variants, expected }) => {
    const sql = await onHandFor(parent, variants);
    // Pinned to the rule, and to the TS twin: agreeing with a wrong twin is
    // not a pass.
    expect(sql).toBe(expected);
    expect(sql).toBe(effectiveInventory({ inventory: parent, variants }));
  });
});
