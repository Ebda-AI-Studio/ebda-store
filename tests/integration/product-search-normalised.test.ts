/**
 * Product search through the Arabic-normalised trigram expression indexes (search program P0,
 * Task 3). Real Egyptian spellings: hamza / ta-marbuta / alef-maqsura variants and Arabic-Indic
 * digits must find the canonical spelling (the Egyptian-variant pairs are from the collected
 * reference vocabulary, Jumia Egypt / Egyptian shop listings, .superpowers/shared/franco-vocab.json).
 * Franco-Arabic only matches through merchant search terms here; Franco expansion is P1.
 * `%` and `_` in a query are LITERAL characters, never LIKE wildcards.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import { searchTokens } from '@ebda/shared';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { searchProductIds, searchProductIdSet, searchNameIds, PRODUCT_SEARCH_ID_CAP } =
  await import('../../apps/api/src/services/product-search.service');
const { ProductService } = await import('../../apps/api/src/services/product.service');
const { BulkService } = await import('../../apps/api/src/services/bulk.service');
const { PromotionService } = await import('../../apps/api/src/services/promotion.service');

const run = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
let storeId: string;
let otherStoreId: string;
let bigStoreId: string;
const ownerIds: string[] = [];
const ids: Record<string, string> = {};

async function mkStore(slug: string) {
  const owner = await prisma.user.create({
    data: {
      email: `ps-${slug}@t.local`,
      passwordHash: 'x',
      firstName: 'Ps',
      lastName: 'Owner',
      role: 'store_admin',
    },
  });
  ownerIds.push(owner.id);
  return (await prisma.store.create({ data: { name: slug, slug, ownerId: owner.id } })).id;
}
async function mk(store: string, key: string, data: Record<string, unknown>) {
  const p = await prisma.product.create({
    data: {
      storeId: store,
      slug: `${key}-${run}`,
      price: 1000,
      status: 'active',
      name: key,
      ...data,
    },
  });
  ids[key] = p.id;
}

describe.skipIf(!hasDb)('normalised product search', () => {
  beforeAll(async () => {
    storeId = await mkStore(`ps-a-${run}`);
    otherStoreId = await mkStore(`ps-b-${run}`);
    bigStoreId = await mkStore(`ps-c-${run}`);
    await mk(storeId, 'shoes', { name: 'Leather shoes', nameAr: 'أحذية جلد طبيعي' });
    await mk(storeId, 'pasta', { name: 'Pasta', nameAr: 'مكرونة إيطالي' });
    await mk(storeId, 'abaya', {
      name: 'Abaya',
      nameAr: 'عباية سوداء',
      searchTerms: '3abaya, عبايه',
    });
    await mk(storeId, 'pct', { name: 'Sale 50% off bundle' });
    await mk(storeId, 'size', { name: 'Shirt', nameAr: 'قميص مقاس 42' });
    await mk(storeId, 'draft', { name: 'Draft shoes', nameAr: 'أحذية', status: 'draft' });
    await mk(storeId, 'skuonly', { name: 'Mug', sku: 'MUG-٧٧' });
    // Canonical (MSA-ish) spellings; the queries below type the Egyptian variant.
    await mk(storeId, 'isdal', { name: 'Prayer isdal', nameAr: 'إسدال صلاة' });
    await mk(storeId, 'galabeya', { name: 'House galabeya', nameAr: 'جلابية بيتي' });
    await mk(storeId, 'sleeveless', { name: 'Sleeveless dress', nameAr: 'فستان بدون أكمام' });
    await mk(storeId, 'gulf', { name: 'Gulf abaya', nameAr: 'عباية خليجي' });
    await mk(storeId, 'sneakers', { name: 'Sneakers', nameAr: 'كوتشي رجالي' });
    await mk(otherStoreId, 'foreign', { name: 'Leather shoes', nameAr: 'أحذية' });
    // PRODUCT_SEARCH_ID_CAP + 1 matches in their own store: the admin list must say it is capped.
    await prisma.product.createMany({
      data: Array.from({ length: PRODUCT_SEARCH_ID_CAP + 1 }, (_, i) => ({
        storeId: bigStoreId,
        slug: `big-${i}-${run}`,
        price: 1000,
        status: 'active' as const,
        name: `Tarha ${i}`,
        nameAr: `طرحة ${i}`,
      })),
    });
  });
  afterAll(async () => {
    const stores = [storeId, otherStoreId, bigStoreId].filter(Boolean);
    await prisma.promotion.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.bundle.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.product.deleteMany({ where: { storeId: { in: stores } } });
    await prisma.store.deleteMany({ where: { id: { in: stores } } });
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
  });

  const q = (raw: string, scope: 'storefront' | 'admin' = 'storefront', field?: 'doc' | 'name') =>
    runInTenantContext(storeId, () => searchProductIds(storeId, raw, { scope, field }));

  it('hamza + ta-marbuta spelling finds the product', async () => {
    expect(await q('احذيه')).toEqual([ids.shoes]);
  });
  it('dialect spelling of pasta', async () => {
    expect(await q('مكرونه')).toContain(ids.pasta);
  });
  it('Franco-Arabic via merchant search terms', async () => {
    expect(await q('3abaya')).toEqual([ids.abaya]);
  });
  it('Arabic-Indic digits match Latin digits', async () => {
    expect(await q('مقاس ٤٢')).toEqual([ids.size]);
  });
  it('word-AND, any order', async () => {
    expect(await q('جلد احذيه')).toEqual([ids.shoes]);
  });
  it.each([
    ['اسدال صلاه', 'isdal'],
    ['جلابيه بيتى', 'galabeya'],
    ['فستان بدون اكمام', 'sleeveless'],
    ['عبايه خليجى', 'gulf'],
    ['كوتشى رجالى', 'sneakers'],
  ])('Egyptian spelling %s finds the canonical product (%s)', async (query, key) => {
    expect(await q(query)).toEqual([ids[key]]);
  });
  it('escapes LIKE wildcards: % and _ are literal characters', async () => {
    expect(await q('50%')).toEqual([ids.pct]);
    // The only name with a literal % in it; a wildcard % would return every product.
    expect(await q('%')).toEqual([ids.pct]);
    // No product text contains an underscore; a wildcard _ would match every product.
    expect(await q('_')).toEqual([]);
  });
  it('storefront hides drafts, admin shows them', async () => {
    expect(await q('احذيه')).not.toContain(ids.draft);
    expect(await q('احذيه', 'admin')).toContain(ids.draft);
  });
  it('admin matches SKU with Arabic-Indic digits', async () => {
    expect(await q('mug-77', 'admin')).toEqual([ids.skuonly]);
    expect(await q('mug-77')).toEqual([]);
  });
  it('typeahead (name field) does not match description-only words', async () => {
    await prisma.product.update({
      where: { id: ids.pasta },
      data: { description: 'contains durum wheat' },
    });
    expect(await q('durum', 'storefront', 'name')).toEqual([]);
    expect(await q('durum')).toEqual([ids.pasta]);
  });
  it('never returns another store', async () => {
    expect(await q('leather shoes')).not.toContain(ids.foreign);
    expect(await q('leather shoes', 'admin')).not.toContain(ids.foreign);
  });
  it('blank query returns []', async () => {
    expect(await q('   ')).toEqual([]);
  });
  it('the database caps search_terms at 500 characters for every writer', async () => {
    await expect(
      prisma.product.update({ where: { id: ids.abaya }, data: { searchTerms: 'ع'.repeat(501) } })
    ).rejects.toThrow(/products_search_terms_len_chk/);
    await prisma.product.update({
      where: { id: ids.abaya },
      data: { searchTerms: 'ع'.repeat(500) },
    });
    await prisma.product.update({
      where: { id: ids.abaya },
      data: { searchTerms: '3abaya, عبايه' },
    });
  });
  it('the token cap lives in searchTokens (8 words)', () => {
    expect(searchTokens('a b c d e f g h i j')).toHaveLength(8);
  });

  describe('callers', () => {
    const inStore = <T>(fn: () => Promise<T>) => runInTenantContext(storeId, fn);

    it('admin list finds the Egyptian spelling and is not truncated', async () => {
      const res = await inStore(() => ProductService.list(storeId, { search: 'احذيه' }));
      expect(res.products.map(p => p.id).sort()).toEqual([ids.shoes, ids.draft].sort());
      expect(res.meta.truncated).toBe(false);
    });
    it('admin list reports truncated when more than the id cap match', async () => {
      const set = await runInTenantContext(bigStoreId, () =>
        searchProductIdSet(bigStoreId, 'طرحه', { scope: 'admin' })
      );
      expect(set.ids).toHaveLength(PRODUCT_SEARCH_ID_CAP);
      expect(set.truncated).toBe(true);
      const res = await runInTenantContext(bigStoreId, () =>
        ProductService.list(bigStoreId, { search: 'طرحه', limit: 5 })
      );
      expect(res.meta.truncated).toBe(true);
      expect(res.meta.total).toBe(PRODUCT_SEARCH_ID_CAP);
    });
    it('storefront list (listPublic) finds the Egyptian spelling, never drafts', async () => {
      const res = await inStore(() => ProductService.listPublic(storeId, { search: 'احذيه' }));
      expect(res.products.map(p => p.id)).toEqual([ids.shoes]);
    });
    it('advanced search finds the Egyptian spelling', async () => {
      const res = await inStore(() => ProductService.advancedSearch(storeId, { query: 'احذيه' }));
      expect(res.products.map(p => p.id)).toEqual([ids.shoes]);
    });
    it('typeahead suggest finds the Egyptian spelling by name only', async () => {
      const res = await inStore(() => ProductService.getSuggestSuggestions(storeId, 'جلابيه'));
      expect((res.suggestions as Array<{ id: string }>).map(s => s.id)).toEqual([ids.galabeya]);
      const none = await inStore(() => ProductService.getSuggestSuggestions(storeId, 'durum'));
      expect(none.suggestions).toEqual([]);
    });
    it('search suggestions find the Egyptian spelling', async () => {
      const res = await inStore(() => ProductService.getSearchSuggestions(storeId, 'كوتشى'));
      const products = (res.suggestions as { products: Array<{ id: string }> }).products;
      expect(products.map(p => p.id)).toEqual([ids.sneakers]);
    });
    it('CSV export search folds Arabic and matches SKU digits', async () => {
      const csv = await inStore(() => BulkService.exportProducts(storeId, { search: 'احذيه' }));
      expect(csv).toContain('Leather shoes');
      expect(csv).not.toContain('Sneakers');
      const sku = await inStore(() => BulkService.exportProducts(storeId, { search: 'mug-77' }));
      expect(sku).toContain('Mug');
    });
    it('promotion and bundle name search fold Arabic spellings', async () => {
      const promo = await prisma.promotion.create({
        data: {
          storeId,
          name: `Eid ${run}`,
          nameAr: 'تخفيضات العيد على الطرحة',
          type: 'percentage',
          value: 10,
        },
      });
      const res = await inStore(() => PromotionService.list(storeId, { search: 'الطرحه' }));
      expect(res.promotions.map(p => p.id)).toEqual([promo.id]);
      const bundle = await prisma.bundle.create({
        data: {
          storeId,
          name: `Set ${run}`,
          nameAr: 'طقم إسدال',
          slug: `set-${run}`,
          pricingType: 'fixed_price',
          pricingValue: 12000,
        },
      });
      expect(await inStore(() => searchNameIds('bundles', storeId, 'اسدال'))).toEqual([bundle.id]);
      expect(await inStore(() => searchNameIds('bundles', storeId, '%'))).toEqual([]);
    });
  });
});
