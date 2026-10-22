/**
 * Phase B3 Task 3 (Ruling B3-5) against real Postgres: the tag source behind the skin-type /
 * concern chips, and the `?tag=` filter every chip lands on.
 *
 * - `getPublicTags` lists only tags with at least one ACTIVE, PUBLIC, non-deleted product, most
 *   used first, at most 12, with the real count; an empty tag is never a chip (no dead ends).
 * - tenant-isolated: another store's tags never appear (negative control), and a foreign store's
 *   tag NAME filters nothing in this store.
 * - `listPublic({ tag })` returns exactly that tag's products, ANDed with the other filters.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

const { ProductService } = await import('../../apps/api/src/services/product.service');

const OWNER_ID = '00000000-0000-0000-0000-0000000b3501';
let storeId: string;
let otherStoreId: string;
const pid: Record<string, string> = {};

async function mkStore(label: string) {
  const slug = `tagchips-${label}-${randomUUID().slice(0, 8)}`;
  return (await prisma.store.create({ data: { name: slug, slug, ownerId: OWNER_ID } })).id;
}
async function mkProduct(
  sid: string,
  key: string,
  data: {
    status?: 'active' | 'draft';
    deletedAt?: Date;
    audience?: 'public' | 'wholesale_only';
  } = {}
) {
  const p = await prisma.product.create({
    data: {
      storeId: sid,
      name: `Tag ${key}`,
      slug: `tg-${key}-${randomUUID().slice(0, 8)}`,
      price: 1000,
      inventory: 5,
      status: 'active',
      ...data,
    },
  });
  pid[key] = p.id;
  return p.id;
}
async function tag(sid: string, name: string, productKeys: string[]) {
  const t = await prisma.tag.create({ data: { storeId: sid, name } });
  for (const k of productKeys)
    await prisma.productTag.create({ data: { productId: pid[k], tagId: t.id } });
  return t.id;
}

describe.skipIf(!hasDb)('tag chips source and ?tag= filter', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: OWNER_ID },
      update: {},
      create: {
        id: OWNER_ID,
        email: `tagchips-owner-${Date.now()}@example.test`,
        passwordHash: 'x',
        firstName: 'Tag',
        lastName: 'Chips',
      },
    });
    storeId = await mkStore('a');
    otherStoreId = await mkStore('b');
    for (const k of ['a1', 'a2', 'a3']) await mkProduct(storeId, k);
    await mkProduct(storeId, 'draft', { status: 'draft' });
    await mkProduct(storeId, 'gone', { deletedAt: new Date() });
    await mkProduct(storeId, 'wholesale', { audience: 'wholesale_only' });
    await mkProduct(otherStoreId, 'f1');
    await tag(storeId, 'بشرة دهنية', ['a1', 'a2', 'a3']);
    await tag(storeId, 'حب الشباب', ['a1']);
    await tag(storeId, 'فاضي', []); // no products at all
    await tag(storeId, 'مسودة بس', ['draft', 'gone', 'wholesale']); // only unpublished products
    await tag(otherStoreId, 'تصبغات', ['f1']); // another store's tag
    await tag(otherStoreId, 'بشرة دهنية', ['f1']); // same NAME in another store
  });

  it('lists only tags with published products, most used first, with the real count', async () => {
    expect(await ProductService.getPublicTags(storeId)).toEqual([
      expect.objectContaining({ name: 'بشرة دهنية', productCount: 3 }),
      expect.objectContaining({ name: 'حب الشباب', productCount: 1 }),
    ]);
  });

  it('negative controls: empty tag, draft/deleted/wholesale-only tag and the other store tag never appear', async () => {
    const names = (await ProductService.getPublicTags(storeId)).map(t => t.name);
    for (const n of ['فاضي', 'مسودة بس', 'تصبغات']) expect(names, n).not.toContain(n);
    const other = await ProductService.getPublicTags(otherStoreId);
    expect(other.map(t => t.name).sort()).toEqual(['بشرة دهنية', 'تصبغات'].sort());
    expect(other.find(t => t.name === 'بشرة دهنية')!.productCount).toBe(1);
  });

  it('is capped at 12 chips', async () => {
    const s = await mkStore('many');
    await mkProduct(s, 'm1');
    for (let i = 0; i < 15; i++) await tag(s, `وسم ${i}`, ['m1']);
    expect(await ProductService.getPublicTags(s)).toHaveLength(12);
  });

  it('?tag= returns exactly that tag products and nothing from another store with the same tag name', async () => {
    const res = await ProductService.listPublic(storeId, { tag: 'بشرة دهنية' });
    expect(res.products.map(p => p.id).sort()).toEqual([pid.a1, pid.a2, pid.a3].sort());
    expect(res.meta.total).toBe(3);
    const narrow = await ProductService.listPublic(storeId, { tag: 'حب الشباب' });
    expect(narrow.products.map(p => p.id)).toEqual([pid.a1]);
    expect(res.products.map(p => p.id)).not.toContain(pid.f1);
  });

  it('an unknown tag, and a tag that exists only in another store, filter to an empty page (never everything)', async () => {
    expect((await ProductService.listPublic(storeId, { tag: 'مش موجود' })).products).toEqual([]);
    expect((await ProductService.listPublic(storeId, { tag: 'تصبغات' })).products).toEqual([]);
  });

  it('the tag ANDs with the other filters (a price floor above every product empties it)', async () => {
    const res = await ProductService.listPublic(storeId, { tag: 'بشرة دهنية', minPrice: 5000 });
    expect(res.products).toEqual([]);
  });
});
