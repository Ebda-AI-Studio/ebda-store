/**
 * #1371 — `ProductService.listPublic` cursor paging, against real Postgres.
 *
 *  - The merchant-ordered category path (no `sort`, a known category) used to
 *    answer EVERY cursor request with `allSorted.slice(1, limit + 1)`,
 *    whatever the cursor said, and never returned a next cursor.
 *  - The generic keyset path returned the (limit+1)th row as `nextCursor`,
 *    and the next request then skipped that row (`skip: 1`) — one product
 *    lost per page.
 *
 * Both are proven the same way: walk the catalogue page by page following
 * `nextCursor` and require the concatenation to equal the full ordered list,
 * with no gaps and no repeats.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@ebda/database';
import { ProductService } from '../../apps/api/src/services/product.service';

const OWNER_ID = '00000000-0000-0000-0000-000000001371';
let storeId: string;
let categorySlug: string;
/** Product ids in the merchant's category order (position ASC). */
const categoryOrder: string[] = [];
/** Product ids in price ASC order. */
const priceOrder: string[] = [];

const N = 7;
const LIMIT = 3;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: {
      id: OWNER_ID,
      email: `cursor-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Cursor',
      lastName: 'Paging',
    },
  });
  const slug = `cursor-${randomUUID().slice(0, 8)}`;
  const store = await prisma.store.create({ data: { name: slug, slug, ownerId: OWNER_ID } });
  storeId = store.id;
  categorySlug = `cat-${randomUUID().slice(0, 8)}`;
  const category = await prisma.category.create({
    data: { storeId, name: 'Paged', slug: categorySlug },
  });

  const created: Array<{ id: string; position: number; price: number }> = [];
  for (let i = 0; i < N; i++) {
    // Category position runs OPPOSITE to price and creation order, so a
    // window taken from the wrong ordering cannot pass by accident.
    const position = N - i;
    const price = 1000 + i * 100;
    const p = await prisma.product.create({
      data: {
        storeId,
        name: `Paged ${i}`,
        slug: `paged-${randomUUID().slice(0, 8)}`,
        price,
        inventory: 10,
        status: 'active',
        categories: { create: { categoryId: category.id, position } },
      },
    });
    created.push({ id: p.id, position, price });
  }
  categoryOrder.push(...[...created].sort((a, b) => a.position - b.position).map(p => p.id));
  priceOrder.push(...[...created].sort((a, b) => a.price - b.price).map(p => p.id));
});

async function walk(options: { category?: string; sort?: 'price_asc' }, startCursor?: string) {
  const seen: string[] = [];
  let cursor = startCursor;
  for (let guard = 0; guard < 10; guard++) {
    const res = await ProductService.listPublic(storeId, { ...options, limit: LIMIT, cursor });
    const ids = res.products.map(p => p.id);
    seen.push(...ids);
    expect(ids.length).toBeLessThanOrEqual(LIMIT);
    if (!res.meta.nextCursor) return seen;
    // A next cursor must be the last row of THIS page.
    expect(res.meta.nextCursor).toBe(ids[ids.length - 1]);
    cursor = res.meta.nextCursor;
  }
  throw new Error('cursor walk did not terminate');
}

describe('listPublic cursor paging (#1371)', () => {
  it('merchant-ordered category: a cursor returns the rows after it, not a fixed window', async () => {
    const afterFirst = await ProductService.listPublic(storeId, {
      category: categorySlug,
      limit: LIMIT,
      cursor: categoryOrder[0],
    });
    const afterThird = await ProductService.listPublic(storeId, {
      category: categorySlug,
      limit: LIMIT,
      cursor: categoryOrder[2],
    });
    expect(afterFirst.products.map(p => p.id)).toEqual(categoryOrder.slice(1, 1 + LIMIT));
    expect(afterThird.products.map(p => p.id)).toEqual(categoryOrder.slice(3, 3 + LIMIT));
  });

  it('merchant-ordered category: following nextCursor visits every product once, in order', async () => {
    const firstPage = await ProductService.listPublic(storeId, {
      category: categorySlug,
      limit: LIMIT,
    });
    expect(firstPage.products.map(p => p.id)).toEqual(categoryOrder.slice(0, LIMIT));

    const rest = await walk({ category: categorySlug }, categoryOrder[LIMIT - 1]);
    expect([...categoryOrder.slice(0, LIMIT), ...rest]).toEqual(categoryOrder);
  });

  it('generic keyset path: following nextCursor loses no product between pages', async () => {
    const rest = await walk({ sort: 'price_asc' }, priceOrder[0]);
    expect([priceOrder[0], ...rest]).toEqual(priceOrder);
  });
});
