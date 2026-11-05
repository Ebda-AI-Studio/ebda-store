/**
 * Gold-rate pricing, review fix wave (Ruling B5-36). Real Postgres.
 *  - a rate that moves mid-checkout is PRICE_CHANGED, never a false GOLD_PRICE_DRIFT P1;
 *  - a weight edit or a rounding change that commits between the pre-check and the money transaction is PRICE_CHANGED;
 *  - a fixed variant without its own price is refused, and a legacy one no longer ratchets the product price down;
 *  - the gold catalogue cap is enforced where a product BECOMES gold.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { prisma } from '@ebda/database';
import { OrderService } from '@api/services/order.service';
import { CartService } from '@api/services/cart.service';
import { GoldRateService } from '@api/services/gold-rate/gold-rate.service';
import { assertGoldLinesPriceable, assertSameRates } from '@api/services/gold-rate/gate';
import { PriceResolver } from '@api/services/price-resolver.service';
import { computeGoldUnitPrice } from '../../packages/shared/src/commerce/gold-price';
import {
  hasDb,
  seedBundleStore,
  cartSessionId,
  testShippingAddress,
  type FixtureStore,
} from '../helpers/bundle-fixtures';
import { createProduct, createStore, deleteStores, ownerPool, uid } from '../helpers/gold-sql';

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
const priceAt = (rate: number, step: 1 | 100 | 500 | 1000 = 100, weightMg = 3250) =>
  computeGoldUnitPrice(
    {
      karat: 21,
      weightMg,
      makingChargeType: 'per_gram',
      makingChargeValue: 15000,
      marginBps: 0,
    },
    rate,
    step
  ).unitPrice;

describe.skipIf(!hasDb)('gold gate: review fixes', () => {
  let owner: pg.Pool;
  let fx: FixtureStore;
  let gold: string;
  const extraStores: Array<{ storeId: string; userId: string }> = [];
  const actor = () => ({ userId: fx.ownerId });
  const setRate = (rate: number) =>
    GoldRateService.applyRates(
      fx.storeId,
      { rates: [{ karat: 21, ratePerGram: rate }], confirm: true },
      actor()
    );
  const line = (price: number, quoted: number | null = null) => ({
    key: 'k1',
    productId: gold,
    variantId: null,
    materialisedUnitPrice: price,
    quotedUnitPrice: quoted,
  });
  const gate = (price: number) =>
    assertGoldLinesPriceable(prisma as never, fx.storeId, [line(price)], { requireQuote: true });
  const weight = (weightMg: number) =>
    GoldRateService.setProductPricing(
      fx.storeId,
      gold,
      {
        product: {
          pricingMode: 'gold_rate',
          karat: 21,
          weightMg,
          makingChargeType: 'per_gram',
          makingChargeValue: 15000,
          marginBps: 0,
        },
      },
      actor()
    );
  const orderCount = () => prisma.order.count({ where: { storeId: fx.storeId } });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedBundleStore(`gold-gf-${suffix}`);
    // These gold suites pay by cash on delivery to stay off the gateway, so the store opts in to deferred payment for gold
    // (Ruling SHARIA-GOLD-1: the merchant switch). The prepaid-only default has its own tests (gold payment policy).
    await owner.query(
      `update stores set settings = coalesce(settings, '{}'::jsonb) || '{"goldAllowDeferredPayment": true}'::jsonb where id = $1`,
      [fx.storeId]
    );
    gold = await createProduct(owner, fx.storeId, { ...SPEC, price: 1 });
    await setRate(576323);
    await owner.query(`update products set inventory = 50 where id = $1`, [gold]);
  });
  afterAll(async () => {
    await deleteStores(
      owner,
      extraStores.map(s => s.storeId),
      extraStores.map(s => s.userId)
    );
    await owner.end();
  });

  it('2a. a rate that moved after the caller read the price is PRICE_CHANGED with both prices and NO drift P1', async () => {
    const stale = priceAt(576323);
    await setRate(580000);
    alerts.length = 0;
    const err = await gate(stale).catch(e => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED' });
    expect(err.details.lines[0]).toMatchObject({ previous: stale, current: priceAt(580000) });
    expect(alerts.filter(a => a.source === 'order.gold-price-drift')).toEqual([]);
    // control: the caller holding the current price passes
    await expect(gate(priceAt(580000))).resolves.toMatchObject({ lines: [expect.anything()] });
    await setRate(576323);
  });

  it('2b. a weight edit that commits between the pre-check and the money transaction is PRICE_CHANGED', async () => {
    const g = await gate(priceAt(576323));
    await expect(assertSameRates(prisma as never, fx.storeId, g)).resolves.toBeUndefined(); // control
    await weight(4000);
    try {
      await expect(assertSameRates(prisma as never, fx.storeId, g)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PRICE_CHANGED',
      });
    } finally {
      await weight(3250);
    }
  });

  it('2c. a rounding-step change in between is PRICE_CHANGED even when the price happens to be the same at both steps', async () => {
    await setRate(576370); // 1 922 000 piastres at step 100 AND at step 500: only the step itself differs
    expect(priceAt(576370, 100)).toBe(priceAt(576370, 500));
    const g = await gate(priceAt(576370));
    const set = (roundingStep: 100 | 500) =>
      GoldRateService.updateSettings(
        fx.storeId,
        {
          enabled: true,
          feedEnabled: false,
          feedPremiumBps: 0,
          maxAgeMinutes: 1560,
          jumpConfirmBps: 500,
          roundingStep,
          showBreakdown: false,
        },
        actor()
      );
    await set(500);
    try {
      await expect(assertSameRates(prisma as never, fx.storeId, g)).rejects.toMatchObject({
        code: 'PRICE_CHANGED',
      });
    } finally {
      await set(100);
      await setRate(576323);
    }
  });

  it('2e. a rate write that changes no price (a 1-piastre move rounds away) is still PRICE_CHANGED: the rate id is what was priced from', async () => {
    expect(priceAt(576323)).toBe(priceAt(576324));
    const g = await gate(priceAt(576323));
    await setRate(576324);
    try {
      await expect(assertSameRates(prisma as never, fx.storeId, g)).rejects.toMatchObject({
        code: 'PRICE_CHANGED',
      });
    } finally {
      await setRate(576323);
    }
  });

  it('2d. end to end: a weight edit landing after the gate refuses the order and writes nothing', async () => {
    const s = cartSessionId('gf2d');
    await CartService.addItem(fx.storeId, s, gold, 1);
    const real = PriceResolver.forBuyer.bind(PriceResolver);
    let fired = false;
    const spy = vi
      .spyOn(PriceResolver, 'forBuyer')
      .mockImplementation(async (...a: Parameters<typeof real>) => {
        if (!fired) {
          fired = true;
          await weight(4100); // the gate already passed on the 3.25 g price
        }
        return real(...a);
      });
    const orders = await orderCount();
    try {
      await expect(
        OrderService.create(fx.storeId, undefined, s, {
          shippingAddress: testShippingAddress(),
          paymentMethod: 'cod',
          locale: 'ar',
          source: 'web',
        } as never)
      ).rejects.toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED' });
    } finally {
      spy.mockRestore();
      await weight(3250);
    }
    expect(fired).toBe(true);
    expect(await orderCount()).toBe(orders);
  });

  it('2e. SHARIA-GOLD-1 end to end: with the merchant switch OFF a gold cart cannot be ordered cash on delivery, and nothing is written', async () => {
    const flag = (on: boolean) =>
      owner.query(
        `update stores set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('goldAllowDeferredPayment', $2::boolean) where id = $1`,
        [fx.storeId, on]
      );
    const s = cartSessionId('gf2e');
    await CartService.addItem(fx.storeId, s, gold, 1);
    const orders = await orderCount();
    await flag(false);
    try {
      await expect(
        OrderService.create(fx.storeId, undefined, s, {
          shippingAddress: testShippingAddress(),
          paymentMethod: 'cod',
          locale: 'ar',
          source: 'web',
        } as never)
      ).rejects.toMatchObject({ statusCode: 409, code: 'GOLD_PREPAID_ONLY' });
      expect(await orderCount()).toBe(orders);
    } finally {
      await flag(true);
    }
    // control: the same cart, switch back ON, is accepted (so the refusal above came from the switch, nothing else)
    await expect(
      OrderService.create(fx.storeId, undefined, s, {
        shippingAddress: testShippingAddress(),
        paymentMethod: 'cod',
        locale: 'ar',
        source: 'web',
      } as never)
    ).resolves.toBeTruthy();
    expect(await orderCount()).toBe(orders + 1);
  });

  it('3. a fixed variant with no own price is refused; a legacy one does not ratchet the product price down', async () => {
    const pid = await createProduct(owner, fx.storeId, { ...SPEC, price: 1 });
    const vGold = uid();
    const vLegacy = uid();
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`select set_config('app.gold_reprice','on',true)`);
      await c.query(
        `insert into product_variants (id, product_id, title, price, updated_at) values ($1,$2,'G',1,now())`,
        [vGold, pid]
      );
      await c.query(
        `insert into product_variants (id, product_id, title, price, updated_at, pricing_mode) values ($1,$2,'F',NULL,now(),'fixed')`,
        [vLegacy, pid]
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const spec = {
      pricingMode: 'gold_rate' as const,
      karat: 21 as const,
      weightMg: 3250,
      makingChargeType: 'per_gram' as const,
      makingChargeValue: 15000,
      marginBps: 0,
    };
    // refused: asking for 'fixed' on a variant that has no price of its own
    await expect(
      GoldRateService.setProductPricing(
        fx.storeId,
        pid,
        { product: spec, variants: [{ id: vLegacy, pricingMode: 'fixed' }] },
        actor()
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'GOLD_VARIANT_NEEDS_PRICE' });
    // legacy data: the priceless fixed variant is left out of the minimum, so the product follows the gold variant
    await setRate(560000);
    const at = async () =>
      (await owner.query(`select price from products where id = $1`, [pid])).rows[0].price;
    expect(await at()).toBe(priceAt(560000));
    await setRate(590000);
    expect(await at()).toBe(priceAt(590000)); // went UP: it did not stay pinned at the lower old price
    await setRate(576323);
  });

  it('5. the gold catalogue cap is enforced where a product becomes gold (not only by the repricer)', async () => {
    const st = await createStore(owner, `cap-${suffix}`);
    extraStores.push(st);
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`select set_config('app.gold_reprice','on',true)`);
      await c.query(
        `insert into products (id, store_id, name, slug, price, status, inventory, updated_at,
                               pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps)
         select gen_random_uuid()::text, $1, 'P', 'cap-' || g, 1000, 'active', 1, now(), 'gold_rate', 21, 1000, 'fixed', 0, 0
           from generate_series(1, 5000) g`,
        [st.storeId]
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const plain = await createProduct(owner, st.storeId, { price: 5000 });
    await expect(
      GoldRateService.setProductPricing(
        st.storeId,
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
        { userId: st.userId }
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'GOLD_CATALOGUE_TOO_LARGE' });
  }, 60_000);
});
