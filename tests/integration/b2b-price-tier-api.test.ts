/**
 * Merchant price tiers + group pricing + product MOQ/audience (B2B Task 4) against real Postgres: every validation code,
 * cross-store ownership, the plan gate (writes need b2b.wholesale, clearing never does), stale-tier flagging and the
 * cache-invalidation call after each write. The HTTP edge (Zod, guards) is in tests/unit/b2b-price-tier-routes.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';

const spy = vi.hoisted(() => ({ invalidate: vi.fn(async () => undefined) }));
vi.mock('@api/lib/public-cache', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/public-cache')>()),
  invalidateStoreProductCaches: spy.invalidate,
}));

import { PriceTierService } from '@api/services/price-tier.service';
import { CustomerGroupService } from '@api/services/customer-group.service';
import { ProductService } from '@api/services/product.service';
import { hasDb, seedBundleStore, seedProduct } from '../helpers/bundle-fixtures';

const SUF = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const id = {} as Record<string, string>;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    e => (e as { code?: string }).code ?? String(e)
  );

describe.skipIf(!hasDb)('B2B Task 4: tiers, group pricing, product moq / audience', () => {
  beforeAll(async () => {
    const s = await seedBundleStore(`b2bt4-${SUF}`);
    const o = await seedBundleStore(`b2bt4o-${SUF}`);
    id.s = s.storeId;
    id.o = o.storeId;
    id.p = await seedProduct(s.storeId, `p-${SUF}`, { price: 10_000, inventory: 100 });
    id.op = await seedProduct(o.storeId, `op-${SUF}`, { price: 5_000, inventory: 100 });
    id.p2 = await seedProduct(s.storeId, `p2-${SUF}`, { price: 3_000, inventory: 100 });
    const v = await prisma.productVariant.create({
      data: { productId: id.p, title: 'XL', price: 12_000 },
    });
    const ov = await prisma.productVariant.create({ data: { productId: id.op, title: 'OV' } });
    const v2 = await prisma.productVariant.create({
      data: { productId: id.p2, title: 'other-product-variant' },
    });
    id.v = v.id;
    id.ov = ov.id;
    id.v2 = v2.id;
    id.g = (
      await prisma.customerGroup.create({ data: { storeId: s.storeId, name: 'Wholesale' } })
    ).id;
    id.og = (
      await prisma.customerGroup.create({ data: { storeId: o.storeId, name: 'Wholesale' } })
    ).id;
    await prisma.storeFeature.create({
      data: { storeId: s.storeId, featureKey: 'b2b.wholesale', enabled: true },
    });
  });
  afterAll(async () => {
    await prisma.productPriceTier.deleteMany({ where: { storeId: { in: [id.s, id.o] } } });
  });
  beforeEach(() => spy.invalidate.mockClear());

  it('create / list / update / delete lifecycle, each write invalidates the cached public payload', async () => {
    const c = await PriceTierService.create(id.s, id.p, { minQty: 10, priceMinor: 9_000 });
    expect(c.tier).toMatchObject({ minQty: 10, priceMinor: 9_000, variantId: null, groupId: null });
    expect(spy.invalidate).toHaveBeenCalledWith(id.s);
    const u = await PriceTierService.update(id.s, id.p, c.tier.id, { priceMinor: 8_500 });
    expect(u.tier.priceMinor).toBe(8_500);
    expect((await PriceTierService.list(id.s, id.p)).map(t => t.priceMinor)).toEqual([8_500]);
    spy.invalidate.mockClear();
    await PriceTierService.remove(id.s, id.p, c.tier.id);
    expect(spy.invalidate).toHaveBeenCalledWith(id.s);
    expect(await PriceTierService.list(id.s, id.p)).toEqual([]);
  });

  it('refuses with the right code and writes nothing: ABOVE_BASE, NOT_MONOTONE, DUPLICATE, VARIANT_ABOVE_PRODUCT (B2B-12), LIMIT', async () => {
    const t10 = await PriceTierService.create(id.s, id.p, { minQty: 10, priceMinor: 9_000 });
    expect(
      await code(PriceTierService.create(id.s, id.p, { minQty: 20, priceMinor: 10_000 }))
    ).toBe('TIER_ABOVE_BASE');
    expect(await code(PriceTierService.create(id.s, id.p, { minQty: 20, priceMinor: 9_500 }))).toBe(
      'TIER_NOT_MONOTONE'
    );
    expect(await code(PriceTierService.create(id.s, id.p, { minQty: 10, priceMinor: 8_000 }))).toBe(
      'TIER_DUPLICATE'
    );
    // product tier 10+ = 9000; a variant tier priced above it is refused, equal / below is fine
    expect(
      await code(
        PriceTierService.create(id.s, id.p, { variantId: id.v, minQty: 10, priceMinor: 11_000 })
      )
    ).toBe('TIER_VARIANT_ABOVE_PRODUCT');
    expect(
      await code(
        PriceTierService.create(id.s, id.p, { variantId: id.v, minQty: 10, priceMinor: 9_000 })
      )
    ).toBe('ok');
    // limit: 10 per scope
    for (let k = 0; k < 9; k++)
      await PriceTierService.create(id.s, id.p, {
        groupId: id.g,
        minQty: 2 + k,
        priceMinor: 9_000 - k * 100,
      }).catch(() => undefined);
    // (the group scope now holds 9; the 10th fits, the 11th does not)
    expect(
      await code(
        PriceTierService.create(id.s, id.p, { groupId: id.g, minQty: 50, priceMinor: 1_000 })
      )
    ).toBe('ok');
    expect(
      await code(
        PriceTierService.create(id.s, id.p, { groupId: id.g, minQty: 60, priceMinor: 900 })
      )
    ).toBe('TIER_LIMIT');
    expect((await PriceTierService.list(id.s, id.p)).length).toBeGreaterThan(2);
    await prisma.productPriceTier.deleteMany({ where: { storeId: id.s, productId: id.p } });
    expect(t10.tier.id).toBeTruthy();
  });

  it("ownership: another store's product / variant / group, and another product's variant, are 404 and write nothing", async () => {
    expect(await code(PriceTierService.create(id.s, id.op, { minQty: 5, priceMinor: 100 }))).toBe(
      'NOT_FOUND'
    );
    expect(
      await code(
        PriceTierService.create(id.s, id.p, { variantId: id.ov, minQty: 5, priceMinor: 100 })
      )
    ).toBe('NOT_FOUND');
    expect(
      await code(
        PriceTierService.create(id.s, id.p, { variantId: id.v2, minQty: 5, priceMinor: 100 })
      )
    ).toBe('NOT_FOUND');
    expect(
      await code(
        PriceTierService.create(id.s, id.p, { groupId: id.og, minQty: 5, priceMinor: 100 })
      )
    ).toBe('NOT_FOUND');
    expect(await code(PriceTierService.list(id.o, id.p))).toBe('NOT_FOUND');
    expect(await prisma.productPriceTier.count({ where: { productId: id.p } })).toBe(0);
  });

  it('warns below cost, and flags a tier STALE (not clamped) when the base is later lowered under it', async () => {
    await prisma.product.update({ where: { id: id.p }, data: { costPrice: 7_000 } });
    const low = await PriceTierService.create(id.s, id.p, { minQty: 10, priceMinor: 6_500 });
    expect(low.warnings.map(w => w.code)).toEqual(['TIER_BELOW_COST']);
    await prisma.product.update({ where: { id: id.p }, data: { price: 6_000, costPrice: null } });
    expect((await PriceTierService.list(id.s, id.p))[0]).toMatchObject({
      priceMinor: 6_500,
      stale: true,
    });
    await prisma.product.update({ where: { id: id.p }, data: { price: 10_000 } });
    await prisma.productPriceTier.deleteMany({ where: { productId: id.p } });
  });

  it('plan gate: with b2b.wholesale OFF, creating / updating a tier is 403 FEATURE_DISABLED, but deleting and listing still work', async () => {
    const t = await PriceTierService.create(id.s, id.p, { minQty: 10, priceMinor: 9_000 });
    await prisma.storeFeature.updateMany({
      where: { storeId: id.s, featureKey: 'b2b.wholesale' },
      data: { enabled: false },
    });
    try {
      expect(
        await code(PriceTierService.create(id.s, id.p, { minQty: 20, priceMinor: 8_000 }))
      ).toBe('FEATURE_DISABLED');
      expect(
        await code(PriceTierService.update(id.s, id.p, t.tier.id, { priceMinor: 8_000 }))
      ).toBe('FEATURE_DISABLED');
      expect((await PriceTierService.list(id.s, id.p)).length).toBe(1);
      await PriceTierService.remove(id.s, id.p, t.tier.id);
    } finally {
      await prisma.storeFeature.updateMany({
        where: { storeId: id.s, featureKey: 'b2b.wholesale' },
        data: { enabled: true },
      });
    }
  });

  it('group pricing fields round-trip, the list reports tierCount for the delete confirmation, and every group write invalidates', async () => {
    const g = await CustomerGroupService.create(id.s, {
      name: `Pricing ${SUF}`,
      pricingMode: 'percent_off',
      discountBps: 1_250,
      isWholesale: true,
      requiresApproval: true,
    });
    expect(g).toMatchObject({
      pricingMode: 'percent_off',
      discountBps: 1_250,
      isWholesale: true,
      requiresApproval: true,
    });
    await PriceTierService.create(id.s, id.p, { groupId: g.id, minQty: 5, priceMinor: 8_000 });
    spy.invalidate.mockClear();
    const listed = (await CustomerGroupService.list(id.s)).find(x => x.id === g.id)!;
    expect(listed.tierCount).toBe(1);
    await CustomerGroupService.update(id.s, g.id, { discountBps: 2_000 });
    expect(spy.invalidate).toHaveBeenCalledWith(id.s);
    spy.invalidate.mockClear();
    await CustomerGroupService.remove(id.s, g.id);
    expect(spy.invalidate).toHaveBeenCalledWith(id.s);
    expect(await prisma.productPriceTier.count({ where: { groupId: g.id } })).toBe(0); // cascaded
  });

  it('the DB refuses an out-of-range group discount (CHECK 0..9000) even if the edge were bypassed', async () => {
    expect(
      await code(CustomerGroupService.create(id.s, { name: `Bad ${SUF}`, discountBps: 9_001 }))
    ).not.toBe('ok');
  });

  it('product moq / audience: setting them needs b2b.wholesale; clearing never does (B2B-1b)', async () => {
    await ProductService.update(id.s, id.p2, { moq: 6, audience: 'wholesale_only' });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: id.p2 } })).toMatchObject({
      moq: 6,
      audience: 'wholesale_only',
    });
    await prisma.storeFeature.updateMany({
      where: { storeId: id.s, featureKey: 'b2b.wholesale' },
      data: { enabled: false },
    });
    try {
      expect(await code(ProductService.update(id.s, id.p2, { moq: 8 }))).toBe('FEATURE_DISABLED');
      expect(await code(ProductService.update(id.s, id.p, { audience: 'wholesale_only' }))).toBe(
        'FEATURE_DISABLED'
      );
      await ProductService.update(id.s, id.p2, { moq: null, audience: 'public' }); // clearing is always allowed
      expect(await prisma.product.findUniqueOrThrow({ where: { id: id.p2 } })).toMatchObject({
        moq: null,
        audience: 'public',
      });
    } finally {
      await prisma.storeFeature.updateMany({
        where: { storeId: id.s, featureKey: 'b2b.wholesale' },
        data: { enabled: true },
      });
    }
  });
});
