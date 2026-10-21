/**
 * Storefront (B2B Task 6) against real Postgres: wholesale-only products are invisible to every anonymous surface and to
 * authenticated non-members (404, no existence oracle) and reachable only by approved members through no-store routes
 * (Review Focus 9); the public payload carries the MOQ and PUBLIC tiers only (Review Focus 1); the buyer price endpoint is
 * session-only, strict and private (Focus 2); search slots are not occupied by hidden products (raw-SQL checklist).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { prisma } from '@ebda/database';

vi.mock('@api/middleware/auth', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/middleware/auth')>()),
  // header-driven stand-in for a verified customer session (the real token pipeline is not under test here)
  optionalAuthenticate: (req: any, _res: any, next: any) => {
    const u = req.headers['x-test-user'];
    if (u) req.user = { userId: u, role: 'customer' };
    next();
  },
}));
vi.mock('@api/middleware/security', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/middleware/security')>()),
  cartLimiter: (_q: any, _r: any, n: any) => n(),
  couponAttemptLimiter: (_q: any, _r: any, n: any) => n(),
  writeLimiter: (_q: any, _r: any, n: any) => n(),
}));

import { publicWholesaleRouter } from '@api/routes/wholesale.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { ProductService } from '@api/services/product.service';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import { searchProductIds } from '@api/services/product-search.service';
import type { BuyerIdentity } from '@api/lib/buyer-identity';
import { ANONYMOUS_BUYER } from '@api/lib/buyer-identity';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  cartSessionId,
  testShippingAddress,
} from '../helpers/bundle-fixtures';

const SUF = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const id = {} as Record<string, string>;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    e => (e as { code?: string }).code ?? String(e)
  );
const session = (userId: string) => ({ kind: 'session', userId }) as unknown as BuyerIdentity;
const app = express();
app.use(express.json());
app.use('/public', publicWholesaleRouter);
app.use(errorHandler);
const H = (user?: string) => ({ 'x-store-id': id.s!, ...(user ? { 'x-test-user': user } : {}) });

describe.skipIf(!hasDb)(
  'B2B Task 6: storefront visibility, public payload, buyer price endpoint',
  () => {
    beforeAll(async () => {
      process.env.OPEN_UNPAID_HOLD_CAP = '1000';
      const s = await seedBundleStore(`b2bsf-${SUF}`);
      id.s = s.storeId;
      id.pub = await seedProduct(id.s, id.pubSlug!, {
        name: `Tea ${SUF} public`,
        price: 10_000,
        inventory: 100,
      });
      id.ws = await seedProduct(id.s, id.wsSlug!, {
        name: `Tea ${SUF} wholesale`,
        price: 8_000,
        inventory: 100,
      });
      await prisma.product.update({ where: { id: id.ws }, data: { audience: 'wholesale_only' } });
      id.wsSlug = (await prisma.product.findUniqueOrThrow({ where: { id: id.ws } })).slug;
      id.pubSlug = (await prisma.product.findUniqueOrThrow({ where: { id: id.pub } })).slug;
      await prisma.product.update({ where: { id: id.pub }, data: { moq: 3 } });
      const g = await prisma.customerGroup.create({
        data: {
          storeId: id.s,
          name: 'Wholesale',
          isWholesale: true,
          pricingMode: 'percent_off',
          discountBps: 1_000,
        },
      });
      const inactive = await prisma.customerGroup.create({
        data: { storeId: id.s, name: 'Dormant', isWholesale: true, isActive: false },
      });
      const user = (tag: string) =>
        prisma.user.create({
          data: {
            email: `b2bsf-${tag}-${SUF}@test.com`,
            passwordHash: 'x',
            firstName: tag,
            lastName: 'T',
            role: 'customer',
            emailVerified: true,
            storeId: id.s!,
          },
        });
      const member = await user('member');
      const plain = await user('plain');
      const dormant = await user('dormant');
      id.member = member.id;
      id.plain = plain.id;
      id.dormant = dormant.id;
      await prisma.customer.create({
        data: {
          storeId: id.s,
          email: member.email,
          firstName: 'M',
          lastName: 'T',
          groupId: g.id,
          userId: member.id,
        },
      });
      await prisma.customer.create({
        data: {
          storeId: id.s,
          email: dormant.email,
          firstName: 'D',
          lastName: 'T',
          groupId: inactive.id,
          userId: dormant.id,
        },
      });
      await prisma.customer.create({
        data: { storeId: id.s, email: plain.email, firstName: 'P', lastName: 'T' },
      });
      await prisma.productPriceTier.createMany({
        data: [
          { storeId: id.s, productId: id.pub, minQty: 10, priceMinor: 9_000 },
          { storeId: id.s, productId: id.pub, minQty: 10, priceMinor: 7_000, groupId: g.id },
          { storeId: id.s, productId: id.pub, minQty: 50, priceMinor: 12_000 }, // stale: above the 10000 base
        ],
      });
      await prisma.storeFeature.create({
        data: { storeId: id.s, featureKey: 'b2b.wholesale', enabled: true },
      });
    });
    afterAll(async () => {
      delete process.env.OPEN_UNPAID_HOLD_CAP;
      if (!id.s) return;
      await prisma.orderItem.deleteMany({ where: { order: { storeId: id.s } } });
      await prisma.order.deleteMany({ where: { storeId: id.s } });
      await prisma.cartItem.deleteMany({ where: { cart: { storeId: id.s } } });
      await prisma.cart.deleteMany({ where: { storeId: id.s } });
    });

    it('RF9: the anonymous public listing, detail, search, suggestions and filters never contain a wholesale-only product', async () => {
      const list = await ProductService.listPublic(id.s!, { limit: 50 });
      expect(list.products.map(p => p.id)).toEqual([id.pub]);
      expect(await code(ProductService.getPublicBySlug(id.s!, id.wsSlug!))).toBe('NOT_FOUND');
      expect(await code(ProductService.getPublicById(id.s!, id.ws!))).toBe('NOT_FOUND');
      const adv = await ProductService.advancedSearch(id.s!, { query: `Tea ${SUF}` });
      expect(adv.products.map((p: { id: string }) => p.id)).toEqual([id.pub]);
      const sug = await ProductService.getSearchSuggestions(id.s!, `Tea ${SUF}`);
      expect(JSON.stringify(sug)).not.toContain(id.ws!);
      const filters = await ProductService.getFilterOptions(id.s!);
      expect(JSON.stringify(filters.priceRange ?? filters)).not.toContain('8000');
    });

    it('raw-SQL search: the storefront scope excludes wholesale-only BEFORE the limit (15 hidden among 12 public still returns 12 public)', async () => {
      const tag = `srch${crypto.randomBytes(3).toString('hex')}`;
      for (let i = 0; i < 12; i++)
        await seedProduct(id.s!, `${tag}-pub-${i}`, {
          name: `${tag} widget ${i}`,
          price: 1_000,
          inventory: 5,
        });
      const hidden: string[] = [];
      for (let i = 0; i < 15; i++) {
        const pid = await seedProduct(id.s!, `${tag}-ws-${i}`, {
          name: `${tag} hidden`, // exact-ish name: ranks ABOVE the public rows, so only the WHERE predicate keeps them out
          price: 1_000,
          inventory: 5,
        });
        await prisma.product.update({ where: { id: pid }, data: { audience: 'wholesale_only' } });
        hidden.push(pid);
      }
      const storefront = await searchProductIds(id.s!, tag, { scope: 'storefront', limit: 12 });
      expect(storefront).toHaveLength(12);
      expect(storefront.some(x => hidden.includes(x))).toBe(false);
      expect(
        await searchProductIds(id.s!, `${tag} hidden`, { scope: 'storefront', limit: 12 })
      ).toEqual([]);
      const admin = await searchProductIds(id.s!, tag, { scope: 'admin', limit: 50 });
      expect(hidden.every(h => admin.includes(h))).toBe(true); // the merchant still finds them
    });

    it('the public product payload carries the MOQ and PUBLIC tiers only: no group tier, no stale tier; tiers vanish with the plan, the MOQ stays (B2B-1b)', async () => {
      const p = await ProductService.getPublicBySlug(id.s!, id.pubSlug!);
      expect(p.moq).toBe(3);
      expect(p.priceTiers).toEqual([{ variantId: null, minQty: 10, priceMinor: 9_000 }]); // 7000 is the group's; 12000 is stale
      await prisma.storeFeature.updateMany({
        where: { storeId: id.s!, featureKey: 'b2b.wholesale' },
        data: { enabled: false },
      });
      try {
        const off = await ProductService.getPublicBySlug(id.s!, id.pubSlug!);
        expect(off.priceTiers).toEqual([]);
        expect(off.moq).toBe(3);
      } finally {
        await prisma.storeFeature.updateMany({
          where: { storeId: id.s!, featureKey: 'b2b.wholesale' },
          data: { enabled: true },
        });
      }
    });

    it("final review minor 2: a VARIANT tier at or above that variant's own price is stale and not shown; one below it is", async () => {
      const v = await prisma.productVariant.create({
        data: { productId: id.pub!, title: `Big ${SUF}`, price: 9_500, inventory: 5 },
      });
      await Promise.all(
        [
          { variantId: v.id, minQty: 5, priceMinor: 9_600 }, // above the variant's 9500: never applied
          { variantId: v.id, minQty: 20, priceMinor: 9_400 }, // a real break for this variant
        ].map(t =>
          prisma.productPriceTier.create({ data: { storeId: id.s!, productId: id.pub!, ...t } })
        )
      );
      try {
        const p = await ProductService.getPublicBySlug(id.s!, id.pubSlug!);
        expect(p.priceTiers).toEqual(
          expect.arrayContaining([
            { variantId: null, minQty: 10, priceMinor: 9_000 },
            { variantId: v.id, minQty: 20, priceMinor: 9_400 },
          ])
        );
        expect(p.priceTiers).toHaveLength(2);
      } finally {
        await prisma.productPriceTier.deleteMany({ where: { variantId: v.id } });
        await prisma.productVariant.delete({ where: { id: v.id } });
      }
    });

    it('cart add: a wholesale-only product is a plain 404 for guests and non-members (same as an unknown product), allowed for an active-group member', async () => {
      const unknown = await CartService.addItem(
        id.s!,
        cartSessionId('sf-unk'),
        crypto.randomUUID(),
        1
      ).catch(e => e);
      for (const buyer of [ANONYMOUS_BUYER, session(id.plain!), session(id.dormant!)]) {
        const err = await CartService.addItem(
          id.s!,
          cartSessionId('sf-a'),
          id.ws!,
          1,
          undefined,
          undefined,
          undefined,
          buyer
        ).catch(e => e);
        expect(err).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
        expect(err.message).toBe(unknown.message); // no existence oracle
      }
      const ok = await CartService.addItem(
        id.s!,
        cartSessionId('sf-m'),
        id.ws!,
        1,
        undefined,
        undefined,
        undefined,
        session(id.member!)
      );
      expect(ok.items.map((i: { productId: string }) => i.productId)).toEqual([id.ws]);
      expect((ok.items[0] as { unitPrice: number }).unitPrice).toBe(7_200); // 10% off 8000
      // bulk add (post-login cart sync) drops it for a non-member too
      const bulk = await CartService.addItems(
        id.s!,
        cartSessionId('sf-b'),
        [{ productId: id.ws!, quantity: 1 }],
        undefined,
        ANONYMOUS_BUYER
      );
      expect(bulk.items).toEqual([]); // the bulk sync treats it exactly like an unknown product: skipped
    });

    it('the cart line reports the highest price break on offer so the stepper can reach it (anonymous: the public break only)', async () => {
      const sessionId = cartSessionId('sf-ladder');
      await CartService.addItem(
        id.s!,
        sessionId,
        id.pub!,
        1,
        undefined,
        undefined,
        undefined,
        ANONYMOUS_BUYER
      );
      const cart = await CartService.getOrCreate(id.s!, sessionId, undefined, ANONYMOUS_BUYER);
      const line = cart.items[0] as { priceSource: string; priceLadderTopMinQty: number | null };
      expect(line.priceSource).toBe('base'); // 1 unit: no break reached yet ...
      expect(line.priceLadderTopMinQty).toBe(10); // ... but the 10+ break is on offer: the cart + button may go there
    });

    it('checkout: a wholesale-only line left in the cart after approval is revoked is refused 409 PRODUCT_NO_LONGER_AVAILABLE', async () => {
      const sessionId = cartSessionId('sf-co');
      await CartService.addItem(
        id.s!,
        sessionId,
        id.ws!,
        1,
        undefined,
        undefined,
        undefined,
        session(id.member!)
      );
      const data = {
        shippingAddress: { ...testShippingAddress() },
        paymentMethod: 'paymob',
      } as never;
      const asMember = await OrderService.create(id.s!, undefined, sessionId, data, undefined, {
        buyer: session(id.member!),
      });
      expect(asMember.items[0]!.productId).toBe(id.ws);
      const sessionId2 = cartSessionId('sf-co2');
      await CartService.addItem(
        id.s!,
        sessionId2,
        id.ws!,
        1,
        undefined,
        undefined,
        undefined,
        session(id.member!)
      );
      const refused = await OrderService.create(id.s!, undefined, sessionId2, data, undefined, {
        buyer: session(id.plain!),
      }).catch(e => e);
      expect(refused).toMatchObject({ statusCode: 409, code: 'PRODUCT_NO_LONGER_AVAILABLE' });
      expect(refused.details.productIds).toEqual([id.ws]);
    });

    describe('POST /public/pricing/resolve (private, session-only, strict)', () => {
      const post = (user: string | undefined, items: unknown[]) =>
        request(app).post('/public/pricing/resolve').set(H(user)).send({ items });
      it('is private / no-store, a guest gets retail + public tiers, a member gets the group price, and the body can carry no price', async () => {
        const guest = await post(undefined, [
          { productId: id.pub, qty: 1 },
          { productId: id.pub, qty: 10 },
        ]);
        expect(guest.status).toBe(200);
        expect(guest.headers['cache-control']).toContain('no-store');
        expect(guest.body.data.prices.map((p: { unitPrice: number }) => p.unitPrice)).toEqual([
          10_000, 9_000,
        ]);
        const member = await post(id.member, [
          { productId: id.pub, qty: 1 },
          { productId: id.pub, qty: 10 },
        ]);
        expect(
          member.body.data.prices.map((p: { unitPrice: number; priceSource: string }) => [
            p.unitPrice,
            p.priceSource,
          ])
        ).toEqual([
          [9_000, 'group'],
          [7_000, 'tier'],
        ]);
        expect((await post(id.member, [{ productId: id.pub, qty: 1, price: 1 }])).status).toBe(400);
        expect((await post(id.member, [{ productId: id.pub, qty: 1.5 }])).status).toBe(400);
        expect(
          (
            await request(app)
              .post('/public/pricing/resolve')
              .set(H(id.member))
              .send({ items: [{ productId: id.pub, qty: 1 }], unitPrice: 1 })
          ).status
        ).toBe(400);
        expect(
          (
            await post(
              id.member,
              Array.from({ length: 51 }, () => ({ productId: id.pub, qty: 1 }))
            )
          ).status
        ).toBe(400);
      });
      it('a wholesale-only product is priced for a member and simply ABSENT for everyone else (no oracle)', async () => {
        const member = await post(id.member, [{ productId: id.ws, qty: 1 }]);
        expect(member.body.data.prices).toHaveLength(1);
        for (const u of [undefined, id.plain!, id.dormant!]) {
          const r = await post(u, [{ productId: id.ws, qty: 1 }]);
          expect(r.status).toBe(200);
          expect(r.body.data.prices).toEqual([]);
        }
      });
    });

    describe("the approved buyer's wholesale catalogue", () => {
      it('lists / shows wholesale-only products for an active-group member, no-store; a plain 404 for guests and non-members', async () => {
        const list = await request(app).get('/public/wholesale/products').set(H(id.member));
        expect(list.status).toBe(200);
        expect(list.headers['cache-control']).toContain('no-store');
        const ids = list.body.data.products.map((p: { id: string }) => p.id);
        expect(ids).toContain(id.ws);
        expect(ids).not.toContain(id.pub);
        const audiences = await prisma.product.findMany({
          where: { id: { in: ids } },
          select: { audience: true },
        });
        expect(new Set(audiences.map(a => a.audience))).toEqual(new Set(['wholesale_only']));
        const one = await request(app)
          .get(`/public/wholesale/products/${id.wsSlug}`)
          .set(H(id.member));
        expect(one.status).toBe(200);
        expect(one.body.data.product.id).toBe(id.ws);
        for (const u of [undefined, id.plain!, id.dormant!]) {
          expect((await request(app).get('/public/wholesale/products').set(H(u))).status).toBe(404);
          expect(
            (await request(app).get(`/public/wholesale/products/${id.wsSlug}`).set(H(u))).status
          ).toBe(404);
        }
        // a PUBLIC product is not served by the wholesale-only detail route
        expect(
          (await request(app).get(`/public/wholesale/products/${id.pubSlug}`).set(H(id.member)))
            .status
        ).toBe(404);
      });
    });
  }
);
