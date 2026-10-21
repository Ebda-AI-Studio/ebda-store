/**
 * Tasks 4-6 review fixes, against real Postgres: C1 recommendations never surface a wholesale-only product (and the cache is
 * dropped when a product's audience flips), I1 bundles, I3 atomic decisions, I4 revoke, I5 merchant notification + nudge,
 * M1 consent, M2 export, M3 cooldown after revoke, M4 reviews answer like an unknown id.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';

vi.mock('@api/services/email.service', async importOriginal => {
  const real = await importOriginal<typeof import('@api/services/email.service')>();
  return {
    ...real,
    EmailService: {
      ...real.EmailService,
      sendWholesaleNotice: vi.fn(async () => undefined),
      sendWholesaleMerchantNotice: vi.fn(async () => undefined),
    },
  };
});
vi.mock('@api/services/onesignal.service', async importOriginal => {
  const real = await importOriginal<typeof import('@api/services/onesignal.service')>();
  return {
    ...real,
    OneSignalService: {
      ...real.OneSignalService,
      notifyAdminsOfWholesaleApplication: vi.fn(async () => undefined),
    },
  };
});

import { WholesaleApplicationService } from '@api/services/wholesale-application.service';
import { EmailService } from '@api/services/email.service';
import { OneSignalService } from '@api/services/onesignal.service';
import { socketService } from '@api/services/socket.service';
import { recommendationService } from '@api/services/recommendation.service';
import { ProductService } from '@api/services/product.service';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import { ReviewService } from '@api/services/review.service';
import { AuthService } from '@api/services/auth.service';
import { listPurchasableBundles, resolveBundle } from '@api/services/bundle.service';
import { nudgeStore } from '@api/lib/inngest/functions/wholesale-pending-nudge';
import type { BuyerIdentity } from '@api/lib/buyer-identity';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  seedBundle,
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
const names = (xs: unknown[]) => (xs as Array<{ id: string }>).map(x => x.id);

async function shopper(tag: string) {
  return prisma.user.create({
    data: {
      email: `b2brf-${tag}-${SUF}@test.com`,
      passwordHash: 'x',
      firstName: tag,
      lastName: 'S',
      role: 'customer',
      emailVerified: true,
      storeId: id.s,
    },
  });
}
const form = (o: Record<string, unknown> = {}) => ({
  businessName: 'Cairo Traders',
  phone: '+201000000123',
  consent: true as const,
  ...o,
});

describe.skipIf(!hasDb)('B2B review fixes (Tasks 4-6)', () => {
  beforeAll(async () => {
    process.env.OPEN_UNPAID_HOLD_CAP = '1000';
    const s = await seedBundleStore(`b2brf-${SUF}`);
    id.s = s.storeId;
    id.owner = s.ownerId;
    id.A = await seedProduct(id.s, `A-${SUF}`, { price: 10_000, inventory: 100 });
    id.B = await seedProduct(id.s, `B-${SUF}`, { price: 8_000, inventory: 100 });
    id.C = await seedProduct(id.s, `C-${SUF}`, { price: 5_000, inventory: 100 });
    await prisma.product.update({ where: { id: id.B }, data: { audience: 'wholesale_only' } });
    id.ws = (
      await prisma.customerGroup.create({
        data: {
          storeId: id.s,
          name: 'Wholesale',
          isWholesale: true,
          pricingMode: 'percent_off',
          discountBps: 1_000,
        },
      })
    ).id;
    id.ws2 = (
      await prisma.customerGroup.create({
        data: { storeId: id.s, name: 'Wholesale gold', isWholesale: true },
      })
    ).id;
    id.retail = (
      await prisma.customerGroup.create({
        data: { storeId: id.s, name: 'Everyone', isDefault: true },
      })
    ).id;
    await prisma.storeFeature.create({
      data: { storeId: id.s, featureKey: 'b2b.wholesale', enabled: true },
    });
    const m = await shopper('member');
    id.member = m.id;
    await prisma.customer.create({
      data: {
        storeId: id.s,
        email: m.email,
        firstName: 'M',
        lastName: 'S',
        groupId: id.ws,
        userId: m.id,
      },
    });
  });
  afterAll(async () => {
    await prisma.wholesaleApplication.deleteMany({ where: { storeId: id.s } });
  });

  describe('C1: recommendations never show a wholesale-only product', () => {
    const idsOf = (r: { crossSell: unknown[]; upsell: unknown[]; alsoLike: unknown[] }) => [
      ...names(r.crossSell),
      ...names(r.upsell),
      ...names(r.alsoLike),
    ];

    it("a wholesale order of A with B (fbt job) does not put B on A's page, in the cart strip or anywhere else", async () => {
      const data = {
        shippingAddress: { ...testShippingAddress() },
        paymentMethod: 'paymob',
      } as never;
      for (const label of ['rf-o1', 'rf-o2']) {
        const sid = cartSessionId(label);
        for (const p of [id.A, id.B]) {
          await CartService.addItem(
            id.s,
            sid,
            p,
            1,
            undefined,
            undefined,
            undefined,
            session(id.member)
          );
        }
        const order = await OrderService.create(id.s, undefined, sid, data, undefined, {
          buyer: session(id.member),
        });
        await prisma.order.update({ where: { id: order.id }, data: { status: 'confirmed' } });
      }
      await recommendationService.recalculateFBT(id.s);
      const pair = await prisma.frequentlyBoughtTogether.findMany({ where: { storeId: id.s } });
      expect(
        pair.length,
        'the job did write the A<->B pair (the leak precondition)'
      ).toBeGreaterThan(0);
      await recommendationService.invalidateProductCache(id.s, id.A);
      const rec = await recommendationService.getProductRecommendations(id.s, id.A);
      expect(idsOf(rec)).not.toContain(id.B);
      expect(JSON.stringify(rec)).not.toContain(id.B);
      const cart = await recommendationService.getCartRecommendations(id.s, [id.A]);
      expect(names(cart)).not.toContain(id.B);
    });

    it('a merchant cross-sell, upsell and an AI recommendation pointing at B are filtered too', async () => {
      await prisma.productRelation.createMany({
        data: [
          {
            storeId: id.s,
            sourceProductId: id.A,
            targetProductId: id.B,
            type: 'cross_sell',
            position: 0,
          },
          {
            storeId: id.s,
            sourceProductId: id.C,
            targetProductId: id.B,
            type: 'upsell',
            position: 0,
          },
        ],
      });
      await prisma.aiRecommendation.create({
        data: {
          storeId: id.s,
          sourceProductId: id.C,
          targetProductId: id.B,
          score: 0.9,
          reason: 'x',
        },
      });
      await recommendationService.invalidateProductCache(id.s, id.A);
      await recommendationService.invalidateProductCache(id.s, id.C);
      expect(
        idsOf(await recommendationService.getProductRecommendations(id.s, id.A))
      ).not.toContain(id.B);
      expect(
        idsOf(await recommendationService.getProductRecommendations(id.s, id.C))
      ).not.toContain(id.B);
      expect(
        names(await recommendationService.getCartRecommendations(id.s, [id.A, id.C]))
      ).not.toContain(id.B);
      await prisma.productRelation.deleteMany({ where: { storeId: id.s } });
      await prisma.aiRecommendation.deleteMany({ where: { storeId: id.s } });
    });

    it('flipping a product to wholesale-only drops the cached recommendations that embed it (cache invalidation)', async () => {
      const D = await seedProduct(id.s, `D-${SUF}`, { price: 4_000, inventory: 10 });
      await prisma.productRelation.create({
        data: {
          storeId: id.s,
          sourceProductId: id.A,
          targetProductId: D,
          type: 'cross_sell',
          position: 0,
        },
      });
      await recommendationService.invalidateProductCache(id.s, id.A);
      expect(idsOf(await recommendationService.getProductRecommendations(id.s, id.A))).toContain(D); // cached now
      await ProductService.update(id.s, D, { audience: 'wholesale_only' });
      expect(
        idsOf(await recommendationService.getProductRecommendations(id.s, id.A))
      ).not.toContain(D);
      await prisma.productRelation.deleteMany({ where: { storeId: id.s } });
    });
  });

  describe('I1: a bundle with a wholesale-only component is neither listed nor sellable', () => {
    it('is not purchasable, not in the public list, and cannot be carted', async () => {
      const mixed = await seedBundle(id.s, `rf-mixed-${SUF}`, {
        pricingType: 'percentage',
        pricingValue: 1_000,
        items: [
          { productId: id.A, quantity: 1 },
          { productId: id.B, quantity: 1 },
        ],
      });
      const clean = await seedBundle(id.s, `rf-clean-${SUF}`, {
        pricingType: 'percentage',
        pricingValue: 1_000,
        items: [
          { productId: id.A, quantity: 1 },
          { productId: id.C, quantity: 1 },
        ],
      });
      expect((await resolveBundle(prisma, id.s, mixed)).isPurchasable).toBe(false);
      expect((await resolveBundle(prisma, id.s, clean)).isPurchasable).toBe(true);
      const listed = (await listPurchasableBundles(prisma, id.s)).map(b => b.id);
      expect(listed).toContain(clean);
      expect(listed).not.toContain(mixed);
      const sid = cartSessionId('rf-bundle');
      expect(await CartService.addBundle(id.s, sid, mixed, 1)).toEqual({
        ok: false,
        error: 'bundle_not_purchasable',
      });
      expect(
        await CartService.addBundle(id.s, sid, mixed, 1, undefined, session(id.member))
      ).toEqual({
        ok: false,
        error: 'bundle_not_purchasable',
      });
      expect((await CartService.addBundle(id.s, sid, clean, 1)).ok).toBe(true);
    });
  });

  describe('I3: approve / reject / revoke are atomic claims', () => {
    it('approve racing reject: exactly one wins, the loser is 409, and the row and the link agree', async () => {
      for (let i = 0; i < 4; i++) {
        const u = await shopper(`race${i}`);
        const app = await WholesaleApplicationService.apply(id.s, u.id, form());
        const [a, r] = await Promise.allSettled([
          WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner),
          WholesaleApplicationService.reject(id.s, app.id, 'no', id.owner),
        ]);
        const won = [a, r].filter(x => x.status === 'fulfilled').length;
        expect(won, `round ${i}`).toBe(1);
        const lost = [a, r].find(x => x.status === 'rejected') as PromiseRejectedResult;
        expect(lost.reason).toMatchObject({ statusCode: 409, code: 'NOT_PENDING' });
        const row = await prisma.wholesaleApplication.findUniqueOrThrow({ where: { id: app.id } });
        const linked = await prisma.customer.findFirst({
          where: { storeId: id.s, userId: u.id, group: { isWholesale: true } },
        });
        expect(!!linked, `round ${i}: wholesale link iff approved`).toBe(row.status === 'approved');
      }
    });

    it('a decided application cannot be flipped: reject after approve is 409 and the row stays approved', async () => {
      const u = await shopper('flip');
      const app = await WholesaleApplicationService.apply(id.s, u.id, form());
      await WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner);
      expect(await code(WholesaleApplicationService.reject(id.s, app.id, 'late', id.owner))).toBe(
        'NOT_PENDING'
      );
      expect(
        (await prisma.wholesaleApplication.findUniqueOrThrow({ where: { id: app.id } })).status
      ).toBe('approved');
    });

    it('two approves at once: one 409; a double revoke: one 409', async () => {
      const u = await shopper('dbl');
      const app = await WholesaleApplicationService.apply(id.s, u.id, form());
      const res = await Promise.allSettled([
        WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner),
        WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner),
      ]);
      expect(res.filter(x => x.status === 'fulfilled')).toHaveLength(1);
      const rv = await Promise.allSettled([
        WholesaleApplicationService.revoke(id.s, app.id, null, id.owner),
        WholesaleApplicationService.revoke(id.s, app.id, null, id.owner),
      ]);
      expect(rv.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    });
  });

  describe('I4: revoke takes the buyer out of wholesale, wherever they are now, and says what happened', () => {
    it('a buyer moved by hand to ANOTHER wholesale group is still removed', async () => {
      const u = await shopper('mv1');
      const app = await WholesaleApplicationService.apply(id.s, u.id, form());
      await WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner);
      await prisma.customer.updateMany({
        where: { storeId: id.s, userId: u.id },
        data: { groupId: id.ws2 },
      });
      const rev = await WholesaleApplicationService.revoke(id.s, app.id, null, id.owner);
      expect(rev.membership).toBe('removed');
      const c = await prisma.customer.findFirstOrThrow({ where: { storeId: id.s, userId: u.id } });
      expect(c.groupId).toBe(id.retail);
    });
    it('a buyer already moved to a retail group: the revoke closes the application and reports already_not_wholesale', async () => {
      const u = await shopper('mv2');
      const app = await WholesaleApplicationService.apply(id.s, u.id, form());
      await WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner);
      await prisma.customer.updateMany({
        where: { storeId: id.s, userId: u.id },
        data: { groupId: id.retail },
      });
      const rev = await WholesaleApplicationService.revoke(id.s, app.id, null, id.owner);
      expect(rev).toMatchObject({ status: 'revoked', membership: 'already_not_wholesale' });
    });
    it('M3: a revoked buyer cannot re-apply for 30 days', async () => {
      const u = await shopper('mv3');
      const app = await WholesaleApplicationService.apply(id.s, u.id, form());
      await WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner);
      await WholesaleApplicationService.revoke(id.s, app.id, null, id.owner);
      expect(await code(WholesaleApplicationService.apply(id.s, u.id, form()))).toBe(
        'REAPPLY_COOLDOWN'
      );
    });
  });

  describe('I5: the merchant is told', () => {
    it('apply -> socket event + push + email to the owner; summary counts pending and the oldest age', async () => {
      const sock = vi
        .spyOn(socketService, 'notifyStore')
        .mockImplementation(() => undefined as never);
      const u = await shopper('n1');
      await WholesaleApplicationService.apply(id.s, u.id, form({ businessName: 'Nile Foods' }));
      await vi.waitFor(() => {
        expect(sock).toHaveBeenCalledWith(
          id.s,
          expect.objectContaining({ type: 'wholesale.application.received' })
        );
        expect(OneSignalService.notifyAdminsOfWholesaleApplication).toHaveBeenCalledWith(
          expect.objectContaining({ storeId: id.s, kind: 'received', businessName: 'Nile Foods' })
        );
        expect(EmailService.sendWholesaleMerchantNotice).toHaveBeenCalledWith(
          id.s,
          expect.objectContaining({ kind: 'received', businessName: 'Nile Foods' })
        );
      });
      const sum = await WholesaleApplicationService.summary(id.s);
      expect(sum.pendingCount).toBeGreaterThanOrEqual(1);
      expect(sum.oldestPendingHours).toBeGreaterThanOrEqual(0);
      sock.mockRestore();
    });

    it('a failing channel never loses the application (fail-soft)', async () => {
      vi.mocked(EmailService.sendWholesaleMerchantNotice).mockRejectedValueOnce(
        new Error('smtp down')
      );
      const u = await shopper('n2');
      const app = await WholesaleApplicationService.apply(id.s, u.id, form());
      expect(app.status).toBe('pending');
      expect(
        (await prisma.wholesaleApplication.findUnique({ where: { id: app.id } }))?.status
      ).toBe('pending');
    });

    it('48h nudge: an application is nudged once, on the run after it turns 48h old; younger and older ones are not', async () => {
      const store = (await seedBundleStore(`b2brfn-${SUF}`)).storeId;
      const mk = async (hours: number, tag: string) => {
        const u = await prisma.user.create({
          data: {
            email: `b2brfn-${tag}-${SUF}@test.com`,
            passwordHash: 'x',
            firstName: tag,
            lastName: 'S',
            role: 'customer',
            emailVerified: true,
            storeId: store,
          },
        });
        return prisma.wholesaleApplication.create({
          data: {
            storeId: store,
            userId: u.id,
            businessName: tag,
            phone: '+201000000000',
            createdAt: new Date(Date.now() - hours * 3_600_000),
          },
        });
      };
      await mk(10, 'young');
      expect(await nudgeStore(store)).toBe(0); // nothing is 48h old yet
      await mk(50, 'due');
      vi.mocked(EmailService.sendWholesaleMerchantNotice).mockClear();
      expect(await nudgeStore(store)).toBe(2); // pending total reported
      expect(EmailService.sendWholesaleMerchantNotice).toHaveBeenCalledWith(
        store,
        expect.objectContaining({ kind: 'nudge', pendingCount: 2 })
      );
      // the next day's run: the same application is now 74h old and is outside the window
      expect(await nudgeStore(store, new Date(Date.now() + 24 * 3_600_000))).toBe(0);
      await prisma.wholesaleApplication.deleteMany({ where: { storeId: store } });
    });
  });

  describe('minors', () => {
    it('M1: apply stores the consent timestamp', async () => {
      const u = await shopper('c1');
      const app = await WholesaleApplicationService.apply(id.s, u.id, form());
      expect(app.consentAt).toBeInstanceOf(Date);
    });
    it("M2: the export carries the applicant's own fields, not the deciding staff id", async () => {
      const u = await shopper('x1');
      const app = await WholesaleApplicationService.apply(id.s, u.id, form());
      await WholesaleApplicationService.reject(id.s, app.id, 'not a trader', id.owner);
      const out = (await AuthService.exportAccount(u.id)) as unknown as {
        wholesaleApplications: Array<Record<string, unknown>>;
      };
      expect(out.wholesaleApplications).toHaveLength(1);
      expect(out.wholesaleApplications[0]).toMatchObject({
        businessName: 'Cairo Traders',
        status: 'rejected',
      });
      expect(Object.keys(out.wholesaleApplications[0]!)).not.toContain('decidedBy');
    });
    it('M4: reviews of a wholesale-only product answer exactly like an unknown id (empty)', async () => {
      const m = await shopper('rv');
      const someOrder = await prisma.order.findFirstOrThrow({ where: { storeId: id.s } });
      await prisma.review.create({
        data: {
          storeId: id.s,
          productId: id.B,
          orderId: someOrder.id,
          customerId: m.id,
          rating: 5,
          body: 'great wholesale goods, would order again soon',
          status: 'published',
        } as never,
      });
      const hidden = await ReviewService.listByProduct(id.s, id.B, {});
      const unknown = await ReviewService.listByProduct(id.s, crypto.randomUUID(), {});
      expect(JSON.stringify(hidden)).toBe(JSON.stringify(unknown));
      expect(await ReviewService.getProductReviewStats(id.s, id.B)).toEqual(
        await ReviewService.getProductReviewStats(id.s, crypto.randomUUID())
      );
    });
  });
});
