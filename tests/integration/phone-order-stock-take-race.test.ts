/**
 * Phone-order stock override, Postgres side: the units an override takes are decided by ONE atomic clamped statement
 * (`takeUpToInventory`), never by a read followed by a write. With a checkout racing it for the same last units, the units each
 * side reports taken must add up to exactly what left the shelf (so the ledger and the `stock_not_taken` marker are true, and a
 * later cancel restocks exactly that). The DO twin of this race is `apps/api/workers-do/admin-order.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@ebda/database';
import {
  decrementProductInventory,
  takeUpToInventory,
} from '../../apps/api/src/services/inventory-decrement';
import { hasDb } from '../helpers/bundle-fixtures';

const sfx = Date.now().toString(36);
let storeId = '';
let userId = '';

describe.skipIf(!hasDb)('takeUpToInventory vs a racing sale (phone-order override)', () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: {
        email: `take-race-${sfx}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'T',
        lastName: 'R',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = u.id;
    storeId = (
      await prisma.store.create({
        data: { name: 'TakeRace', slug: `take-race-${sfx}`, ownerId: u.id, status: 'active' },
      })
    ).id;
  });
  afterAll(async () => {
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  const mk = (inventory: number, i: number) =>
    prisma.product.create({
      data: {
        storeId,
        name: 'Tee',
        slug: `tee-${sfx}-${i}`,
        price: 10_000,
        status: 'active',
        inventory,
        trackInventory: true,
      },
    });

  it('the units reported taken always equal what left the shelf, however the sale interleaves', async () => {
    for (let i = 0; i < 25; i++) {
      const p = await mk(5, i);
      const [override, sale] = await Promise.all([
        prisma.$transaction(tx => takeUpToInventory(tx, { productId: p.id }, 5)),
        prisma.$transaction(tx => decrementProductInventory(tx, p.id, 3)),
      ]);
      const left = (await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).inventory;
      const overrideTaken = override.previousStock - override.newStock;
      const saleTaken = sale.ok ? 3 : 0;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(overrideTaken + saleTaken).toBe(5 - left); // ledger == actually taken
      expect(override.newStock).toBeGreaterThanOrEqual(0);
    }
  });

  it('never takes more than is on hand and leaves a negative backorder debt alone', async () => {
    const p = await mk(2, 100);
    const r = await prisma.$transaction(tx => takeUpToInventory(tx, { productId: p.id }, 5));
    expect(r).toEqual({ previousStock: 2, newStock: 0 });
    const debt = await mk(-4, 101);
    const d = await prisma.$transaction(tx => takeUpToInventory(tx, { productId: debt.id }, 5));
    expect(d.previousStock - d.newStock).toBe(0);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: debt.id } })).inventory).toBe(-4);
  });
});
