/**
 * Phase B2 Task 3: `ProductService.listPublic({ sort: 'on_sale' })` against real Postgres.
 * ON SALE = a variant-less active product whose compare-at exceeds its price, or a variant product
 * with an ACTIVE variant whose own compare-at exceeds its own price (the parent's stale compare-at
 * is ignored). Biggest relative drop first, capped at 12, storeId-scoped; drafts, archived,
 * deleted products and another store's products never appear (negative controls). A price edit
 * through ProductService.update reaches the list and fires the cache invalidator (BOUNDED-stale).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

const invalidated: string[] = [];
vi.mock('../../apps/api/src/lib/public-cache', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    invalidateStoreProductCaches: vi.fn(async (storeId: string) => {
      invalidated.push(storeId);
    }),
  };
});

const { ProductService } = await import('../../apps/api/src/services/product.service');

const OWNER_ID = '00000000-0000-0000-0000-0000000b2501';
let storeId: string;
let otherStoreId: string;
const id: Record<string, string> = {};

async function mkStore(label: string) {
  const slug = `onsale-${label}-${randomUUID().slice(0, 8)}`;
  return (await prisma.store.create({ data: { name: slug, slug, ownerId: OWNER_ID } })).id;
}
async function mkProduct(
  sid: string,
  key: string,
  data: {
    price: number;
    compareAtPrice?: number;
    status?: 'active' | 'draft' | 'archived';
    deletedAt?: Date;
  }
) {
  const p = await prisma.product.create({
    data: {
      storeId: sid,
      name: `OnSale ${key}`,
      slug: `os-${key}-${randomUUID().slice(0, 8)}`,
      inventory: 10,
      status: 'active',
      ...data,
    },
  });
  id[key] = p.id;
  return p;
}

describe.skipIf(!hasDb)('listPublic sort=on_sale', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: OWNER_ID },
      update: {},
      create: {
        id: OWNER_ID,
        email: `onsale-owner-${Date.now()}@example.test`,
        passwordHash: 'x',
        firstName: 'On',
        lastName: 'Sale',
      },
    });
    storeId = await mkStore('a');
    otherStoreId = await mkStore('b');
    await mkProduct(storeId, 'full', { price: 1000 });
    await mkProduct(storeId, 'equal', { price: 1000, compareAtPrice: 1000 });
    await mkProduct(storeId, 'small', { price: 900, compareAtPrice: 1000 }); // 10%
    await mkProduct(storeId, 'big', { price: 500, compareAtPrice: 1000 }); // 50%
    await mkProduct(storeId, 'draft', { price: 100, compareAtPrice: 1000, status: 'draft' });
    await mkProduct(storeId, 'archived', { price: 100, compareAtPrice: 1000, status: 'archived' });
    await mkProduct(storeId, 'deleted', {
      price: 100,
      compareAtPrice: 1000,
      deletedAt: new Date(),
    });
    await mkProduct(otherStoreId, 'foreign', { price: 100, compareAtPrice: 1000 });
    // variant product: stale parent compare-at, one real variant sale (20%), one inactive big sale
    await mkProduct(storeId, 'varSale', { price: 1000, compareAtPrice: 5000 });
    await prisma.productVariant.createMany({
      data: [
        {
          productId: id.varSale,
          name: 'S',
          price: 800,
          compareAtPrice: 1000,
          inventory: 5,
          isActive: true,
        },
        { productId: id.varSale, name: 'M', price: 1000, inventory: 5, isActive: true },
        {
          productId: id.varSale,
          name: 'XL',
          price: 100,
          compareAtPrice: 1000,
          inventory: 5,
          isActive: false,
        },
      ] as never,
    });
    // variant product with ONLY a stale parent compare-at: not on sale
    await mkProduct(storeId, 'varStale', { price: 1000, compareAtPrice: 5000 });
    await prisma.productVariant.createMany({
      data: [
        { productId: id.varStale, name: 'S', price: 1000, inventory: 5, isActive: true },
      ] as never,
    });
  });

  it('returns exactly the products on sale, biggest relative drop first', async () => {
    const res = await ProductService.listPublic(storeId, { sort: 'on_sale', limit: 12 });
    expect(res.products.map(p => p.id)).toEqual([id.big, id.varSale, id.small]);
  });

  it('negative controls: draft, archived, deleted, equal compare-at, stale parent, foreign store never appear', async () => {
    const ids = (await ProductService.listPublic(storeId, { sort: 'on_sale' })).products.map(
      p => p.id
    );
    for (const k of ['full', 'equal', 'draft', 'archived', 'deleted', 'varStale', 'foreign'])
      expect(ids, k).not.toContain(id[k]);
    const other = await ProductService.listPublic(otherStoreId, { sort: 'on_sale' });
    expect(other.products.map(p => p.id)).toEqual([id.foreign]);
  });

  it('is capped at 12 and ignores paging beyond the first page', async () => {
    for (let i = 0; i < 14; i++)
      await mkProduct(storeId, `bulk${i}`, { price: 400 + i, compareAtPrice: 1000 });
    const res = await ProductService.listPublic(storeId, { sort: 'on_sale', limit: 100, page: 3 });
    expect(res.products).toHaveLength(12);
    expect(res.meta.limit).toBe(12);
  });

  it('a price edit through ProductService.update reaches the list and fires the cache invalidator', async () => {
    invalidated.length = 0;
    await ProductService.update(storeId, id.small, { price: 100 }); // 10% -> 90%
    expect(invalidated).toContain(storeId);
    const ids = (
      await ProductService.listPublic(storeId, { sort: 'on_sale', limit: 12 })
    ).products.map(p => p.id);
    expect(ids[0]).toBe(id.small);
    // ending the sale removes it
    await ProductService.update(storeId, id.small, { price: 1000 });
    const after = (
      await ProductService.listPublic(storeId, { sort: 'on_sale', limit: 12 })
    ).products.map(p => p.id);
    expect(after).not.toContain(id.small);
  });
});
