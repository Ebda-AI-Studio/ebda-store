/**
 * Inventory atomic-decrement — no-oversell invariant under concurrency.
 *
 * Proves the safety property behind the order-placement refactor
 * (docs/superpowers/plans/2026-06-05-checkout-concurrency-scaling.md, Task 2):
 * the conditional `UPDATE … WHERE inventory >= qty` guarantees that when N
 * concurrent checkouts race for a hot SKU, exactly `stock` of them win and the
 * inventory floors at 0 — never negative, never oversold — without a
 * SELECT … FOR UPDATE held across the whole order transaction.
 *
 * Real DB required (CI integration job provides Postgres). Self-contained:
 * creates its own owner/store/products and cleans them up.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { decrementProductInventory } from '../../apps/api/src/services/inventory-decrement';

describe('inventory atomic decrement — no oversell under concurrency', () => {
  let storeId: string;
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `inv-dec-${Date.now()}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'Inv',
        lastName: 'Test',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = user.id;
    const store = await prisma.store.create({
      data: {
        name: 'Inventory Decrement Test Store',
        slug: `inv-dec-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    storeId = store.id;
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function makeProduct(inventory: number, tag: string): Promise<string> {
    const p = await prisma.product.create({
      data: {
        storeId,
        name: 'Hot SKU',
        slug: `hot-sku-${tag}-${Date.now()}`,
        price: 5000,
        inventory,
        status: 'active',
      },
    });
    return p.id;
  }

  async function raceDecrements(productId: string, attempts: number) {
    return Promise.all(
      Array.from({ length: attempts }, () =>
        prisma.$transaction(tx => decrementProductInventory(tx, productId, 1))
      )
    );
  }

  it('inventory=1, 20 concurrent decrements → exactly 1 wins, inventory floors at 0', async () => {
    const productId = await makeProduct(1, 'one');
    const results = await raceDecrements(productId, 20);

    expect(results.filter(r => r.ok).length).toBe(1);
    const after = await prisma.product.findUnique({ where: { id: productId } });
    expect(after?.inventory).toBe(0); // never negative
  });

  it('inventory=5, 20 concurrent decrements → exactly 5 win, inventory floors at 0', async () => {
    const productId = await makeProduct(5, 'five');
    const results = await raceDecrements(productId, 20);

    expect(results.filter(r => r.ok).length).toBe(5);
    const after = await prisma.product.findUnique({ where: { id: productId } });
    expect(after?.inventory).toBe(0);
  });
});
