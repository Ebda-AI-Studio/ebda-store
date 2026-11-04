/**
 * Gold-rate pricing, Task 12 (Rulings B5-17, B5-18, B5-19): checkout re-prices on the SERVER. Real
 * Postgres, `OrderService` driven in-process like the other checkout suites. The oracle for every
 * price is `computeGoldUnitPrice` (the ONE formula, proven separately in gold-price.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { prisma, withRlsBypass } from '@ebda/database';
import { OrderService } from '@api/services/order.service';
import { CartService } from '@api/services/cart.service';
import { ReturnService } from '@api/services/return.service';
import { GoldRateService } from '@api/services/gold-rate/gold-rate.service';
import { PriceResolver } from '@api/services/price-resolver.service';
import { computeGoldUnitPrice } from '../../packages/shared/src/commerce/gold-price';
import { goldLineSnapshotSchema } from '../../packages/shared/src/schemas/gold-pricing';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  cartSessionId,
  testShippingAddress,
  type FixtureStore,
} from '../helpers/bundle-fixtures';
import { createProduct, ownerPool } from '../helpers/gold-sql';

const { alerts } = vi.hoisted(() => ({ alerts: [] as Array<{ level: string; source?: string }> }));
vi.mock('@api/services/alerts.service', async importOriginal => {
  const real = await importOriginal<typeof import('@api/services/alerts.service')>();
  return {
    ...real,
    sendAlert: async (o: { level: string; source?: string }) => {
      alerts.push(o);
      return {} as never;
    },
  };
});

const suffix = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
const SPEC = {
  mode: 'gold_rate' as const,
  karat: 21,
  weightMg: 3250,
  makingType: 'per_gram' as const,
  makingValue: 15000,
};
const priceAt = (rate: number, step: 1 | 100 | 500 | 1000 = 100, margin = 0) =>
  computeGoldUnitPrice(
    {
      karat: 21,
      weightMg: 3250,
      makingChargeType: 'per_gram',
      makingChargeValue: 15000,
      marginBps: margin,
    },
    rate,
    step
  ).unitPrice;

describe.skipIf(!hasDb)(
  'gold checkout: server-side re-price, stale block, snapshot, refunds',
  () => {
    let owner: pg.Pool;
    let fx: FixtureStore;
    let gold: string;
    let fixed: string;
    const actor = () => ({ userId: fx.ownerId });
    const setRate = (rate: number, confirm = true) =>
      GoldRateService.applyRates(
        fx.storeId,
        { rates: [{ karat: 21, ratePerGram: rate }], confirm },
        actor()
      );
    const backdate = (minutes: number) =>
      owner.query(
        `update gold_rates_current set applied_at = (now() AT TIME ZONE 'UTC') - make_interval(mins => $2) where store_id = $1 and karat = 21`,
        [fx.storeId, minutes]
      );
    const stock = async (id: string) =>
      (await prisma.product.findUniqueOrThrow({ where: { id }, select: { inventory: true } }))
        .inventory;
    const orderCount = () => prisma.order.count({ where: { storeId: fx.storeId } });
    const cartOf = async (session: string) => CartService.getOrCreate(fx.storeId, session);
    const place = (session: string, extra: Record<string, unknown> = {}) =>
      OrderService.create(fx.storeId, undefined, session, {
        shippingAddress: testShippingAddress(),
        paymentMethod: 'cod',
        locale: 'ar',
        source: 'web',
        ...extra,
      } as never);
    const add = (session: string, productId: string, qty = 1) =>
      CartService.addItem(fx.storeId, session, productId, qty);

    beforeAll(async () => {
      owner = ownerPool();
      fx = await seedBundleStore(`gold-co-${suffix}`);
      // These gold suites pay by cash on delivery to stay off the gateway, so the store opts in to deferred payment for gold
      // (Ruling SHARIA-GOLD-1: the merchant switch). The prepaid-only default has its own tests (gold payment policy).
      await owner.query(
        `update stores set settings = coalesce(settings, '{}'::jsonb) || '{"goldAllowDeferredPayment": true}'::jsonb where id = $1`,
        [fx.storeId]
      );
      gold = await createProduct(owner, fx.storeId, { ...SPEC, price: 1 });
      fixed = await seedProduct(fx.storeId, `${suffix}-fixed`, { price: 1_921_800, inventory: 50 });
      await setRate(576323);
      await owner.query(`update products set inventory = 50 where id = $1`, [gold]);
    });
    afterAll(async () => {
      await owner.end();
    });

    it('1. RE-PRICE: the rate moves after add-to-cart -> the cart flags it, the order is refused with both prices and writes nothing; acknowledging lets it through at the NEW price', async () => {
      const s = cartSessionId('gold1');
      await add(s, gold);
      const before = await cartOf(s);
      expect(before.items[0]).toMatchObject({ unitPrice: priceAt(576323) });
      expect((before.items[0] as { priceChanged?: boolean }).priceChanged).toBeUndefined();

      await setRate(580000);
      const moved = await cartOf(s);
      expect(moved.items[0]).toMatchObject({
        priceChanged: true,
        previousUnitPrice: priceAt(576323),
        unitPrice: priceAt(580000),
      });

      const stockBefore = await stock(gold);
      const orders = await orderCount();
      await expect(place(s)).rejects.toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED' });
      const refused = await place(s).catch(e => e);
      expect(refused.details.lines[0]).toMatchObject({
        previous: priceAt(576323),
        current: priceAt(580000),
      });
      // nothing written: no order, no stock reserved
      expect(await orderCount()).toBe(orders);
      expect(await stock(gold)).toBe(stockBefore);

      expect(await CartService.acknowledgePrices(fx.storeId, s)).toEqual({ acknowledged: 1 });
      const order = await place(s);
      expect(order.items[0].price).toBe(priceAt(580000));
      expect(order.subtotal).toBe(priceAt(580000));
      // a SECOND acknowledge is a no-op, and the cart no longer flags the line
      expect(await CartService.acknowledgePrices(fx.storeId, cartSessionId('none'))).toEqual({
        acknowledged: 0,
      });
      await setRate(576323);
    });

    it('1b. a dry-run QUOTE returns the new totals instead of refusing (the checkout can show them)', async () => {
      const s = cartSessionId('gold1b');
      await add(s, gold);
      await setRate(581000);
      const q = await OrderService.quote(
        fx.storeId,
        undefined,
        s,
        {
          shippingAddress: testShippingAddress(),
          paymentMethod: 'cod',
          locale: 'ar',
        } as never,
        {} as never
      );
      expect((q as { subtotal: number }).subtotal).toBe(priceAt(581000));
      await setRate(576323);
    });

    it('2. A CLIENT CANNOT SET THE PRICE: extra price / unitPrice / quotedUnitPrice / total keys change nothing', async () => {
      const s = cartSessionId('gold2');
      await add(s, gold);
      const order = await place(s, {
        price: 1,
        unitPrice: 1,
        quotedUnitPrice: 1,
        total: 1,
        subtotal: 1,
      });
      expect(order.items[0].price).toBe(priceAt(576323));
      expect(order.subtotal).toBe(priceAt(576323));
      expect(order.total).toBeGreaterThanOrEqual(priceAt(576323));
    });

    it('3. STALE BLOCK: past the max age the order is refused (GOLD_RATE_STALE) and a fixed-price cart still orders; at max age - 1 minute it succeeds', async () => {
      const s = cartSessionId('gold3');
      await add(s, gold);
      await backdate(1560); // exactly the 26 h default max age
      await expect(place(s)).rejects.toMatchObject({ statusCode: 409, code: 'GOLD_RATE_STALE' });
      const stale = await place(s).catch(e => e);
      expect(stale.details.messageAr).toMatch(/سعر الدهب/);
      // the gate is per gold LINE, not per store: a fixed-price-only cart orders as usual
      const f = cartSessionId('gold3f');
      await add(f, fixed);
      expect((await place(f)).items[0].price).toBe(1_921_800);
      // negative control: one minute inside the limit sells
      await backdate(1559);
      const ok = await place(s);
      expect(ok.items[0].price).toBe(priceAt(576323));
      await setRate(576323);
    });

    it('4. RACE: a rate write that commits between the pre-check and the money transaction becomes PRICE_CHANGED, never an order at the old rate', async () => {
      const s = cartSessionId('gold4');
      await add(s, gold);
      const real = PriceResolver.forBuyer.bind(PriceResolver);
      let fired = false;
      const spy = vi
        .spyOn(PriceResolver, 'forBuyer')
        .mockImplementation(async (...a: Parameters<typeof real>) => {
          if (!fired) {
            fired = true;
            // the gate already passed on rate A; a rate write now commits rate B
            await setRate(579500);
          }
          return real(...a);
        });
      const orders = await orderCount();
      try {
        await expect(place(s)).rejects.toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED' });
      } finally {
        spy.mockRestore();
      }
      expect(fired).toBe(true);
      expect(await orderCount()).toBe(orders);
      await setRate(576323);
    });

    it('5. DRIFT: a corrupted materialised price is GOLD_PRICE_DRIFT with a P1, never a charge', async () => {
      const s = cartSessionId('gold5');
      await add(s, gold);
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query(`select set_config('app.gold_reprice','on',true)`);
        await c.query(`update products set price = price + 100 where id = $1`, [gold]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      alerts.length = 0;
      try {
        await expect(place(s)).rejects.toMatchObject({ statusCode: 409, code: 'GOLD_PRICE_DRIFT' });
        expect(alerts.some(a => a.level === 'p1' && a.source === 'order.gold-price-drift')).toBe(
          true
        );
      } finally {
        await setRate(576323, true); // the repricer heals the row
      }
      // healed: the same cart orders
      expect((await place(s)).items[0].price).toBe(priceAt(576323));
    });

    it('6. SNAPSHOT: the order line carries a complete, Zod-valid gold_snapshot', async () => {
      const s = cartSessionId('gold6');
      await add(s, gold, 2);
      const order = await place(s);
      const item = await prisma.orderItem.findFirstOrThrow({
        where: { orderId: order.id },
        select: { goldSnapshot: true, price: true, quantity: true },
      });
      const snap = goldLineSnapshotSchema.parse(item.goldSnapshot);
      const rate = await prisma.goldRateCurrent.findFirstOrThrow({
        where: { storeId: fx.storeId, karat: 21 },
      });
      expect(snap).toMatchObject({
        v: 1,
        karat: 21,
        weightMg: 3250,
        ratePerGram: 576323,
        rateId: rate.rateId,
        makingChargeType: 'per_gram',
        makingChargeValue: 15000,
        marginBps: 0,
        roundingStep: 100,
        unitPrice: priceAt(576323),
      });
      expect(item.price).toBe(snap.unitPrice);
      // a fixed line has NO snapshot
      const f = cartSessionId('gold6f');
      await add(f, fixed);
      const fo = await place(f);
      expect(
        (await prisma.orderItem.findFirstOrThrow({ where: { orderId: fo.id } })).goldSnapshot
      ).toBeNull();
    });

    it("7. REFUNDS use the price charged, not today's rate; an EXCHANGE of a gold line is refused", async () => {
      const s = cartSessionId('gold7');
      await add(s, gold);
      const order = await place(s);
      const customer = await withRlsBypass(tx =>
        tx.user.create({
          data: {
            email: `gold7-${suffix}@example.com`,
            passwordHash: 'x',
            role: 'customer',
            firstName: 'G',
            lastName: 'C',
          },
        })
      );
      await withRlsBypass(tx =>
        tx.order.update({
          where: { id: order.id },
          data: { status: 'delivered', deliveredAt: new Date(), customerId: customer.id },
        })
      );
      await setRate(560000); // the rate moves AFTER the sale
      const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
      const ex = await ReturnService.create(fx.storeId, {
        orderId: order.id,
        customerId: customer.id,
        type: 'exchange',
        reason: 'wrong size',
        items: [{ orderItemId: line.id, productId: gold, productName: 'Piece', quantity: 1 }],
      }).catch(e => e);
      expect(ex).toMatchObject({ statusCode: 409, code: 'GOLD_EXCHANGE_UNSUPPORTED' });
      const refund = await ReturnService.create(fx.storeId, {
        orderId: order.id,
        customerId: customer.id,
        type: 'refund',
        reason: 'changed my mind',
        items: [{ orderItemId: line.id, productId: gold, productName: 'Piece', quantity: 1 }],
      });
      expect(refund.refundAmount).toBe(line.price); // what was charged, NOT priceAt(560000)
      expect(line.price).toBe(priceAt(576323));
      expect(line.price).not.toBe(priceAt(560000));
      await setRate(576323);
    });

    it('8. ORDER OF OPERATIONS: a gold line and a fixed line of the same unit price give IDENTICAL totals under a coupon (gold changes only the first step)', async () => {
      await withRlsBypass(tx =>
        tx.coupon.create({
          data: {
            storeId: fx.storeId,
            code: `G10-${suffix}`,
            name: 'ten',
            type: 'percentage',
            value: 10,
            isActive: true,
          },
        })
      );
      const unit = priceAt(576323);
      const twin = await seedProduct(fx.storeId, `${suffix}-twin`, { price: unit, inventory: 50 });
      const g = cartSessionId('gold8g');
      await add(g, gold, 2);
      const o1 = await place(g, { couponCode: `G10-${suffix}` });
      const f = cartSessionId('gold8f');
      await add(f, twin, 2);
      const o2 = await place(f, { couponCode: `G10-${suffix}` });
      for (const k of [
        'subtotal',
        'discount',
        'couponDiscount',
        'shipping',
        'tax',
        'total',
      ] as const)
        expect(o1[k], k).toBe(o2[k]);
      expect(o1.subtotal).toBe(unit * 2);
      expect(o1.couponDiscount).toBeGreaterThan(0);
    });

    it('9. ADMIN ORDER: the same gate (stale -> 409), and a fresh gold line is written with its snapshot', async () => {
      await backdate(1600);
      await expect(
        OrderService.createAdminOrder(
          fx.storeId,
          fx.ownerId,
          {
            items: [{ productId: gold, quantity: 1 }],
            shippingAddress: testShippingAddress(),
            paymentMethod: 'cod',
          },
          { role: 'store_admin' }
        )
      ).rejects.toMatchObject({ statusCode: 409, code: 'GOLD_RATE_STALE' });
      await setRate(576323); // a fresh rate
      const order = await OrderService.createAdminOrder(
        fx.storeId,
        fx.ownerId,
        {
          items: [{ productId: gold, quantity: 1 }],
          shippingAddress: testShippingAddress(),
          paymentMethod: 'cod',
        },
        { role: 'store_admin' }
      );
      const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
      expect(goldLineSnapshotSchema.parse(item.goldSnapshot).unitPrice).toBe(priceAt(576323));
      expect(item.price).toBe(priceAt(576323));
    });

    it('11. BUNDLES: a product in a bundle cannot be switched to gold', async () => {
      const plain = await seedProduct(fx.storeId, `${suffix}-bundled`, {
        price: 500000,
        inventory: 5,
      });
      const bundle = await withRlsBypass(tx =>
        tx.bundle.create({
          data: {
            storeId: fx.storeId,
            name: `B-${suffix}`,
            slug: `b-${suffix}`,
            pricingType: 'fixed',
            pricingValue: 400000,
            isActive: true,
          },
        })
      );
      await withRlsBypass(tx =>
        tx.bundleItem.create({ data: { bundleId: bundle.id, productId: plain, quantity: 1 } })
      );
      await expect(
        GoldRateService.setProductPricing(
          fx.storeId,
          plain,
          {
            product: {
              pricingMode: 'gold_rate',
              karat: 21,
              weightMg: 1000,
              makingChargeType: 'fixed',
              makingChargeValue: 0,
            },
          },
          actor()
        )
      ).rejects.toMatchObject({ statusCode: 409, code: 'GOLD_IN_BUNDLE' });
    });
  }
);
