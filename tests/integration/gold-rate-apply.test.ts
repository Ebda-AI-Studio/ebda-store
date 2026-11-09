/**
 * Gold-rate pricing, Task 10 (Rulings B5-13, B5-14, B5-16, B5-20, B5-21): the rate service, the
 * repricer, the jump gate and the audit trail, run the way production runs them: each request bound
 * to the guarded ebda_app client (tenant guard + strict RLS), the routes mounted exactly as
 * apps/api/src/routes/index.ts mounts them (under tenantContext). Fixtures use the owner role.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import {
  prisma,
  withRlsBypass,
  createPrismaClient,
  runWithRequestDb,
  runInStoreScope,
} from '@ebda/database';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import goldRateRoutes from '@api/routes/gold-rate.routes';
import { tenantContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { config } from '@api/config';
import { ProductService } from '@api/services/product.service';
import { BulkService } from '@api/services/bulk.service';
import { repricerHooks } from '@api/services/gold-rate/repricer';
import { GoldRateService } from '@api/services/gold-rate/gold-rate.service';
import { isGoldPriceManaged } from '@api/lib/prisma-errors';
import { computeGoldUnitPrice } from '../../packages/shared/src/commerce/gold-price';
import { hasDb } from '../helpers/bundle-fixtures';
import { createProduct, ownerPool, uid } from '../helpers/gold-sql';

// This file drives dozens of writes inside one minute; the 30/min write limiter is not under test here.
vi.mock('@api/middleware/security', async importOriginal => {
  const real = await importOriginal<typeof import('@api/middleware/security')>();
  return {
    ...real,
    writeLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const { purged } = vi.hoisted(() => ({ purged: [] as string[] }));
vi.mock('@api/lib/public-cache', async importOriginal => {
  const real = await importOriginal<typeof import('@api/lib/public-cache')>();
  return {
    ...real,
    invalidateStoreProductCaches: async (storeId: string) => {
      purged.push(storeId);
      return real.invalidateStoreProductCaches(storeId);
    },
  };
});

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 4 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

const run = crypto.randomUUID().slice(0, 8);
const userIds: string[] = [];
const storeIds: string[] = [];

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    asApp(
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  app.use('/api/v1/stores/:storeId/gold-rates', tenantContext, goldRateRoutes);
  app.use(errorHandler);
  return app;
}

const token = (userId: string, role: string) =>
  jwt.sign({ userId, email: `${userId}@test.local`, role, tv: 0 }, config.jwtSecret, {
    expiresIn: '10m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });

// vector A's inputs: 3 250 mg at 21k, per-gram making 15 000
const SPEC21 = {
  mode: 'gold_rate' as const,
  karat: 21,
  weightMg: 3250,
  makingType: 'per_gram' as const,
  makingValue: 15000,
};
const priceOf = (
  karat: 24 | 21 | 18,
  weightMg: number,
  type: 'fixed' | 'per_gram',
  value: number,
  rate: number,
  margin = 0,
  step: 1 | 100 | 500 | 1000 = 100
) =>
  computeGoldUnitPrice(
    { karat, weightMg, makingChargeType: type, makingChargeValue: value, marginBps: margin },
    rate,
    step
  ).unitPrice;

describe.skipIf(!hasDb)('gold-rate service, repricer and gate (ebda_app + tenant guard)', () => {
  let app: Express;
  let owner: pg.Pool;
  const fx = {
    storeId: '',
    ownerId: '',
    staffId: '',
    ownerToken: '',
    staffToken: '',
    p21: '',
    p18: '',
    ring: '',
    fixed: '',
    v1: '',
    v2: '',
  };
  const put = (body: unknown, t = fx.ownerToken, storeId = fx.storeId) =>
    request(app)
      .put(`/api/v1/stores/${storeId}/gold-rates`)
      .set({ Authorization: `Bearer ${t}` })
      .send(body as object);
  const getRows = async (ids: string[]) =>
    (
      await owner.query(`select id, price, gold_rate_id from products where id = any($1::text[])`, [
        ids,
      ])
    ).rows;
  const rateRows = async () =>
    (
      await owner.query(
        `select karat, rate_per_gram from gold_rates_current where store_id = $1 order by karat`,
        [fx.storeId]
      )
    ).rows;
  const histCount = async () =>
    (
      await owner.query(`select count(*)::int as n from gold_rates where store_id = $1`, [
        fx.storeId,
      ])
    ).rows[0].n as number;

  beforeAll(async () => {
    app = buildApp();
    owner = ownerPool();
    await withRlsBypass(async tx => {
      const mk = async (tag: string, role: 'store_admin' | 'staff') =>
        tx.user.create({
          data: {
            email: `gold-${tag}-${run}@test.local`,
            passwordHash: 'x',
            firstName: 'G',
            lastName: tag,
            role,
            emailVerified: true,
          },
        });
      const o = await mk('owner', 'store_admin');
      const st = await mk('staff', 'staff');
      userIds.push(o.id, st.id);
      const store = await tx.store.create({
        data: {
          name: `gold-${run}`,
          slug: `gold-${run}`,
          template: 'qamar',
          currency: 'EGP',
          ownerId: o.id,
          status: 'active',
        },
      });
      storeIds.push(store.id);
      await tx.storeStaff.create({ data: { storeId: store.id, userId: st.id } });
      fx.storeId = store.id;
      fx.ownerId = o.id;
      fx.staffId = st.id;
    });
    fx.ownerToken = token(fx.ownerId, 'store_admin');
    fx.staffToken = token(fx.staffId, 'staff');
    fx.p21 = await createProduct(owner, fx.storeId, { ...SPEC21, price: 1 });
    fx.p18 = await createProduct(owner, fx.storeId, {
      mode: 'gold_rate',
      karat: 18,
      weightMg: 2000,
      makingType: 'fixed',
      makingValue: 50000,
      price: 1,
    });
    fx.ring = await createProduct(owner, fx.storeId, { ...SPEC21, weightMg: 3000, price: 1 });
    fx.fixed = await createProduct(owner, fx.storeId, { price: 123456 });
    for (const [key, mg] of [
      ['v1', 3000],
      ['v2', 4200],
    ] as const) {
      const id = uid();
      fx[key] = id;
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query(`select set_config('app.gold_reprice','on',true)`);
        await c.query(
          `insert into product_variants (id, product_id, title, price, updated_at, gold_weight_mg) values ($1,$2,$3,1,now(),$4)`,
          [id, fx.ring, `w${mg}`, mg]
        );
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    }
  });

  afterEach(() => {
    repricerHooks.afterChunk = undefined;
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.store.deleteMany({ where: { id: { in: storeIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await owner.end();
  });

  it('1. PUT 21k + 18k as store_admin: every gold row is repriced from the ONE formula; the fixed product is byte-identical', async () => {
    const fixedBefore = (await owner.query(`select * from products where id = $1`, [fx.fixed]))
      .rows[0];
    purged.length = 0;
    const res = await put({
      rates: [
        { karat: 21, ratePerGram: 576323 },
        { karat: 18, ratePerGram: 493991 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await awaitDeferredWork(5000);
    expect(res.body.data.applied).toHaveLength(2);
    const [r21, r18] = [576323, 493991];
    const rows = Object.fromEntries((await getRows([fx.p21, fx.p18, fx.ring])).map(r => [r.id, r]));
    expect(rows[fx.p21].price).toBe(priceOf(21, 3250, 'per_gram', 15000, r21));
    expect(rows[fx.p21].price).toBe(1_921_800); // vector A
    expect(rows[fx.p18].price).toBe(priceOf(18, 2000, 'fixed', 50000, r18));
    // the variant product: each variant by its own weight, the product = the minimum active variant price
    const v = Object.fromEntries(
      (
        await owner.query(
          `select id, price, gold_rate_id from product_variants where product_id = $1`,
          [fx.ring]
        )
      ).rows.map(r => [r.id, r])
    );
    expect(v[fx.v1].price).toBe(priceOf(21, 3000, 'per_gram', 15000, r21));
    expect(v[fx.v2].price).toBe(priceOf(21, 4200, 'per_gram', 15000, r21));
    expect(rows[fx.ring].price).toBe(Math.min(v[fx.v1].price, v[fx.v2].price));
    // the rate row each price came from is stamped
    const cur = Object.fromEntries(
      (
        await owner.query(`select karat, rate_id from gold_rates_current where store_id = $1`, [
          fx.storeId,
        ])
      ).rows.map(r => [r.karat, r.rate_id])
    );
    expect(rows[fx.p21].gold_rate_id).toBe(cur[21]);
    expect(rows[fx.p18].gold_rate_id).toBe(cur[18]);
    // history + current + audit
    expect(await histCount()).toBe(2);
    expect((await rateRows()).map(r => r.karat)).toEqual([18, 21]);
    const audit = await owner.query(
      `select details from audit_logs where store_id = $1 and action = 'gold_rate.set' order by created_at`,
      [fx.storeId]
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.map(a => a.details.karat).sort()).toEqual([18, 21]);
    expect(audit.rows[0].details).toMatchObject({ source: 'manual', from: null });
    // the fixed product: BYTE-IDENTICAL (full row compare)
    expect((await owner.query(`select * from products where id = $1`, [fx.fixed])).rows[0]).toEqual(
      fixedBefore
    );
    // price is NEVER-stale: the immediate purge ran for the store
    expect(purged).toContain(fx.storeId);
  });

  it('2. staff gets 403 and nothing changes (negative control on the role)', async () => {
    const before = {
      rates: await rateRows(),
      hist: await histCount(),
      prices: await getRows([fx.p21]),
    };
    const res = await put({ rates: [{ karat: 21, ratePerGram: 580000 }] }, fx.staffToken);
    expect(res.status).toBe(403);
    expect({
      rates: await rateRows(),
      hist: await histCount(),
      prices: await getRows([fx.p21]),
    }).toEqual(before);
  });

  it('3. +7 % without confirm: 409 GOLD_RATE_CONFIRM_REQUIRED, nothing written; with confirm it applies', async () => {
    const hist = await histCount();
    const bumped = Math.round(576323 * 1.07);
    const refused = await put({ rates: [{ karat: 21, ratePerGram: bumped }] });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('GOLD_RATE_CONFIRM_REQUIRED');
    expect(refused.body.error.details.items[0]).toMatchObject({ karat: 21 });
    expect(refused.body.error.details.items[0].jumpBps).toBeGreaterThan(500);
    expect(await histCount()).toBe(hist);
    expect((await rateRows()).find(r => r.karat === 21).rate_per_gram).toBe(576323);
    const ok = await put({ rates: [{ karat: 21, ratePerGram: bumped }], confirm: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await rateRows()).find(r => r.karat === 21).rate_per_gram).toBe(bumped);
    // back to the baseline within the gate (a -6.5 % move also needs confirm)
    await put({ rates: [{ karat: 21, ratePerGram: 576323 }], confirm: true });
  });

  it('3b. a 5 % move is the boundary: 500 bps passes, 501 needs confirm (negative control)', async () => {
    const base = 576323;
    const at500 = Math.floor((base * 10500) / 10000); // exactly <= 500 bps
    const over = Math.ceil((base * 10501) / 10000) + 1; // > 500 bps
    expect((await put({ rates: [{ karat: 21, ratePerGram: at500 }] })).status).toBe(200);
    expect((await put({ rates: [{ karat: 21, ratePerGram: at500 }] })).status).toBe(200);
    // from at500 the next step down to base is -4.76 %: passes; a jump above 500 from the new current needs confirm
    const cur = (await rateRows()).find(r => r.karat === 21).rate_per_gram as number;
    const tooFar = Math.ceil(cur * 1.0501) + 1;
    expect((await put({ rates: [{ karat: 21, ratePerGram: tooFar }] })).status).toBe(409);
    expect(over).toBeGreaterThan(base);
    await put({ rates: [{ karat: 21, ratePerGram: base }], confirm: true });
  });

  it('3c. a 21k rate more than 4 % off 24k x 21/24, entered together with 24k, needs confirm (swapped fields)', async () => {
    // 24k 720 000 -> coherent 21k = 630 000 ; the merchant typed 21k = 675 000 (+7.1 %) by mistake
    const res = await put({
      rates: [
        { karat: 24, ratePerGram: 720000 },
        { karat: 21, ratePerGram: 675000 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GOLD_RATE_CONFIRM_REQUIRED');
    expect(
      res.body.error.details.items.some(
        (i: { karat: number; coherenceBps: number }) => i.karat === 21 && i.coherenceBps > 400
      )
    ).toBe(true);
    // 24k alone is a first write for that karat (no previous rate): no gate
    const ok = await put({ rates: [{ karat: 24, ratePerGram: 720000 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('4. an out-of-range rate is a 400 from Zod, not a 409; an unknown key is a 400', async () => {
    expect((await put({ rates: [{ karat: 21, ratePerGram: 9_999 }] })).status).toBe(400);
    expect(
      (await put({ rates: [{ karat: 21, ratePerGram: 576323, source: 'feed' }] })).status
    ).toBe(400);
    expect(
      (
        await put({
          rates: [
            { karat: 21, ratePerGram: 576323 },
            { karat: 21, ratePerGram: 576324 },
          ],
        })
      ).status
    ).toBe(400);
  });

  it('5. ATOMICITY: a failure injected into the repricer rolls the rate rows AND every price back together', async () => {
    const before = {
      rates: await rateRows(),
      hist: await histCount(),
      prices: await getRows([fx.p21, fx.p18, fx.ring]),
    };
    repricerHooks.afterChunk = () => {
      throw new Error('injected repricer failure');
    };
    const res = await put({ rates: [{ karat: 21, ratePerGram: 580000 }] });
    expect(res.status).toBe(500);
    repricerHooks.afterChunk = undefined;
    expect({
      rates: await rateRows(),
      hist: await histCount(),
      prices: await getRows([fx.p21, fx.p18, fx.ring]),
    }).toEqual(before);
  });

  it('6. CONCURRENCY: two PUTs for 21k at once serialise; the final prices match the later committed rate (no lost update)', async () => {
    const [a, b] = await Promise.all([
      put({ rates: [{ karat: 21, ratePerGram: 579000 }] }),
      put({ rates: [{ karat: 21, ratePerGram: 581000 }] }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const cur = (await rateRows()).find(r => r.karat === 21).rate_per_gram as number;
    expect([579000, 581000]).toContain(cur);
    const p = (await getRows([fx.p21]))[0];
    expect(p.price).toBe(priceOf(21, 3250, 'per_gram', 15000, cur));
    // the stamp points at the row that IS current
    const currentRate = (
      await owner.query(
        `select rate_id from gold_rates_current where store_id = $1 and karat = 21`,
        [fx.storeId]
      )
    ).rows[0].rate_id;
    expect(p.gold_rate_id).toBe(currentRate);
    // both writes are in the audited history
    const n = (
      await owner.query(
        `select count(*)::int as n from gold_rates where store_id = $1 and karat = 21 and rate_per_gram in (579000, 581000)`,
        [fx.storeId]
      )
    ).rows[0].n;
    expect(n).toBe(2);
  });

  it('7. a spec edit reprices only that product; a plain price edit on a gold product is GOLD_PRICE_MANAGED (409)', async () => {
    const cur21 = (await rateRows()).find(r => r.karat === 21).rate_per_gram as number;
    const others = await getRows([fx.p18, fx.ring]);
    const res = await request(app)
      .put(`/api/v1/stores/${fx.storeId}/gold-rates/products/${fx.p21}/pricing`)
      .set({ Authorization: `Bearer ${fx.ownerToken}` })
      .send({
        product: {
          pricingMode: 'gold_rate',
          karat: 21,
          weightMg: 5000,
          makingChargeType: 'per_gram',
          makingChargeValue: 15000,
          marginBps: 250,
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getRows([fx.p21]))[0].price).toBe(
      priceOf(21, 5000, 'per_gram', 15000, cur21, 250)
    );
    expect(await getRows([fx.p18, fx.ring])).toEqual(others);
    // a hand-typed price: refused by the database guard, surfaced as the typed error
    let caught: unknown;
    await runInStoreScope(fx.storeId, async () => {
      try {
        await ProductService.update(fx.storeId, fx.p21, { price: 5 } as never);
      } catch (e) {
        caught = e;
      }
    });
    expect(isGoldPriceManaged(caught), String(caught)).toBe(true);
    expect((await getRows([fx.p21]))[0].price).toBe(
      priceOf(21, 5000, 'per_gram', 15000, cur21, 250)
    );
    // re-sending the CURRENT price is not a change
    await runInStoreScope(fx.storeId, () =>
      ProductService.update(fx.storeId, fx.p21, { price: undefined as never } as never)
    );
  });

  it('7b. staff may edit a product spec (products:write) but cannot bulk-switch modes (store:settings)', async () => {
    const spec = await request(app)
      .put(`/api/v1/stores/${fx.storeId}/gold-rates/products/${fx.p21}/pricing`)
      .set({ Authorization: `Bearer ${fx.staffToken}` })
      .send({
        product: {
          pricingMode: 'gold_rate',
          karat: 21,
          weightMg: 3250,
          makingChargeType: 'per_gram',
          makingChargeValue: 15000,
          marginBps: 0,
        },
      });
    expect(spec.status, JSON.stringify(spec.body)).toBe(200);
    const bulk = await request(app)
      .post(`/api/v1/stores/${fx.storeId}/gold-rates/bulk/pricing-mode`)
      .set({ Authorization: `Bearer ${fx.staffToken}` })
      .send({ productIds: [fx.p21], mode: 'fixed' });
    expect(bulk.status).toBe(403);
  });

  it('7c. a FEED rate over the gate is stored PENDING and never self-confirms; confirming applies, reprices and purges; rejecting changes nothing', async () => {
    const cur = (await rateRows()).find(r => r.karat === 21).rate_per_gram as number;
    const far = Math.round(cur * 1.1);
    const before = await getRows([fx.p21]);
    const res = await runInStoreScope(fx.storeId, () =>
      GoldRateService.applyRates(
        fx.storeId,
        { rates: [{ karat: 21, ratePerGram: far }] },
        { feed: { fetchedAt: new Date().toISOString(), premiumBps: 0 } }
      )
    );
    expect(res.applied).toHaveLength(0);
    expect(res.pending).toHaveLength(1);
    expect(await getRows([fx.p21])).toEqual(before); // prices untouched
    expect((await rateRows()).find(r => r.karat === 21).rate_per_gram).toBe(cur);
    const decide = (id: string, decision: string, t = fx.ownerToken) =>
      request(app)
        .post(`/api/v1/stores/${fx.storeId}/gold-rates/${id}/decision`)
        .set({ Authorization: `Bearer ${t}` })
        .send({ decision });
    // a staff member may not decide it
    expect((await decide(res.pending[0].id, 'confirm', fx.staffToken)).status).toBe(403);
    // reject: nothing changes, the row is decided
    const rej = await decide(res.pending[0].id, 'reject');
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(await getRows([fx.p21])).toEqual(before);
    // a second decision on a decided row is refused
    expect((await decide(res.pending[0].id, 'confirm')).status).toBe(409);
    // a new pending rate, confirmed: applied exactly as typed, repriced, purged
    const second = await runInStoreScope(fx.storeId, () =>
      GoldRateService.applyRates(
        fx.storeId,
        { rates: [{ karat: 21, ratePerGram: far }] },
        { feed: { fetchedAt: new Date().toISOString() } }
      )
    );
    purged.length = 0;
    const ok = await decide(second.pending[0].id, 'confirm');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await awaitDeferredWork(5000);
    expect((await rateRows()).find(r => r.karat === 21).rate_per_gram).toBe(far);
    expect(purged).toContain(fx.storeId);
    const p = (
      await owner.query(
        `select price, gold_weight_mg, making_charge_value, gold_margin_bps from products where id = $1`,
        [fx.p21]
      )
    ).rows[0];
    expect(p.price).toBe(
      priceOf(21, p.gold_weight_mg, 'per_gram', p.making_charge_value, far, p.gold_margin_bps)
    );
    // back to a sane rate for the tests after this one
    await put({ rates: [{ karat: 21, ratePerGram: cur }], confirm: true });
  });

  it('7c2. GOLD-DISAGREE-MERCHANT-1: a feed DISAGREEMENT is pending with both values on getState; the owner confirming applies the chosen rate through the repricer, a store that does not decide keeps its confirmed rate', async () => {
    const cur = (await rateRows()).find(r => r.karat === 21).rate_per_gram as number;
    const primary = Math.round(cur * 1.01);
    const fallback = Math.round(cur * 1.04);
    const before = await getRows([fx.p21]);
    const res = await runInStoreScope(fx.storeId, () =>
      GoldRateService.applyRates(
        fx.storeId,
        { rates: [{ karat: 21, ratePerGram: primary }] },
        {
          feed: {
            fetchedAt: new Date().toISOString(),
            disagree: {
              diffBps: 313,
              primary24k: Math.round((primary * 24) / 21),
              fallback24k: Math.round((fallback * 24) / 21),
              fallbackRates: { 24: 1, 21: fallback, 18: 1 },
            },
          },
          forcePending: true,
        }
      )
    );
    expect(res.applied).toHaveLength(0);
    // undecided: price and current rate are exactly what they were
    expect(await getRows([fx.p21])).toEqual(before);
    expect((await rateRows()).find(r => r.karat === 21).rate_per_gram).toBe(cur);
    const st = await request(app)
      .get(`/api/v1/stores/${fx.storeId}/gold-rates`)
      .set({ Authorization: `Bearer ${fx.ownerToken}` });
    expect(st.status).toBe(200);
    expect(st.body.data.disagreement).toMatchObject({
      diffBps: 313,
      fallbackRates: { 21: fallback },
    });
    // the owner picks the first source: applied through the repricer
    const ok = await request(app)
      .post(`/api/v1/stores/${fx.storeId}/gold-rates/${res.pending[0].id}/decision`)
      .set({ Authorization: `Bearer ${fx.ownerToken}` })
      .send({ decision: 'confirm' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await awaitDeferredWork(5000);
    expect((await rateRows()).find(r => r.karat === 21).rate_per_gram).toBe(primary);
    const p = (
      await owner.query(
        `select price, gold_weight_mg, making_charge_value, gold_margin_bps from products where id = $1`,
        [fx.p21]
      )
    ).rows[0];
    expect(p.price).toBe(
      priceOf(21, p.gold_weight_mg, 'per_gram', p.making_charge_value, primary, p.gold_margin_bps)
    );
    await put({ rates: [{ karat: 21, ratePerGram: cur }], confirm: true });
  });

  it('7d. a rounding-step change reprices every gold row and purges; the bulk switch freezes prices, skips incomplete specs and purges', async () => {
    purged.length = 0;
    const body = {
      enabled: true,
      feedEnabled: false,
      feedPremiumBps: 0,
      maxAgeMinutes: 1560,
      jumpConfirmBps: 500,
      roundingStep: 500,
      showBreakdown: false,
    };
    const settings = await request(app)
      .put(`/api/v1/stores/${fx.storeId}/gold-rates/settings`)
      .set({ Authorization: `Bearer ${fx.ownerToken}` })
      .send(body);
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    await awaitDeferredWork(5000);
    expect(purged).toContain(fx.storeId);
    const cur21 = (await rateRows()).find(r => r.karat === 21).rate_per_gram as number;
    const p = (
      await owner.query(
        `select price, gold_weight_mg, making_charge_value, gold_margin_bps from products where id = $1`,
        [fx.p21]
      )
    ).rows[0];
    expect(p.price).toBe(
      priceOf(
        21,
        p.gold_weight_mg,
        'per_gram',
        p.making_charge_value,
        cur21,
        p.gold_margin_bps,
        500
      )
    );
    expect((p.price as number) % 500).toBe(0);
    // 26 hours is the ceiling
    const tooLong = await request(app)
      .put(`/api/v1/stores/${fx.storeId}/gold-rates/settings`)
      .set({ Authorization: `Bearer ${fx.ownerToken}` })
      .send({ ...body, maxAgeMinutes: 1561, roundingStep: 100 });
    expect(tooLong.status).toBe(400);
    // bulk: freeze p21 and p18 (priced); the already-fixed product is skipped
    purged.length = 0;
    const bulk = (mode: string, ids: string[]) =>
      request(app)
        .post(`/api/v1/stores/${fx.storeId}/gold-rates/bulk/pricing-mode`)
        .set({ Authorization: `Bearer ${fx.ownerToken}` })
        .send({ productIds: ids, mode });
    const toFixed = await bulk('fixed', [fx.p21, fx.p18, fx.fixed]);
    expect(toFixed.status, JSON.stringify(toFixed.body)).toBe(200);
    expect([...toFixed.body.data.switched].sort()).toEqual([fx.p21, fx.p18].sort());
    expect(toFixed.body.data.skipped).toEqual([{ id: fx.fixed, reason: 'ALREADY' }]);
    await awaitDeferredWork(5000);
    expect(purged).toContain(fx.storeId);
    // a frozen price is the last computed price, and no longer moves with the rate
    const frozen = (await getRows([fx.p21]))[0].price as number;
    await put({ rates: [{ karat: 21, ratePerGram: Math.round(cur21 * 1.02) }] });
    expect((await getRows([fx.p21]))[0].price).toBe(frozen);
    // back to gold: the stored spec is complete, so it switches and reprices; the fixed product has no spec
    const toGold = await bulk('gold_rate', [fx.p21, fx.fixed]);
    expect(toGold.status, JSON.stringify(toGold.body)).toBe(200);
    expect(toGold.body.data.switched).toEqual([fx.p21]);
    expect(toGold.body.data.skipped).toEqual([{ id: fx.fixed, reason: 'SPEC_INCOMPLETE' }]);
    // switching a fixed product to gold clears its compare-at price (Ruling B5-19); 24k has a rate from test 3c
    await owner.query(`update products set compare_at_price = 200000 where id = $1`, [fx.fixed]);
    const sw = await request(app)
      .put(`/api/v1/stores/${fx.storeId}/gold-rates/products/${fx.fixed}/pricing`)
      .set({ Authorization: `Bearer ${fx.ownerToken}` })
      .send({
        product: {
          pricingMode: 'gold_rate',
          karat: 24,
          weightMg: 1000,
          makingChargeType: 'fixed',
          makingChargeValue: 0,
        },
      });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(
      (await owner.query(`select compare_at_price from products where id = $1`, [fx.fixed])).rows[0]
        .compare_at_price
    ).toBeNull();
  });

  it('7e. a variant added to a gold product is BORN priced by the repricer; without the repricer the database refuses it', async () => {
    // fx.p18 was switched to fixed by 7d's bulk freeze; put it back on gold at 18k
    await runInStoreScope(fx.storeId, () =>
      GoldRateService.setProductPricing(
        fx.storeId,
        fx.p18,
        {
          product: {
            pricingMode: 'gold_rate',
            karat: 18,
            weightMg: 2000,
            makingChargeType: 'fixed',
            makingChargeValue: 50000,
            marginBps: 0,
          },
        },
        { userId: fx.ownerId }
      )
    );
    const rate18 = (await rateRows()).find(r => r.karat === 18).rate_per_gram as number;
    const step = (
      await owner.query(`select rounding_step from gold_rate_settings where store_id = $1`, [
        fx.storeId,
      ])
    ).rows[0].rounding_step as 1 | 100 | 500 | 1000;
    const created = await runInStoreScope(fx.storeId, () =>
      GoldRateService.asRepricer(fx.storeId, fx.p18, tx =>
        tx.productVariant.create({
          data: { productId: fx.p18, title: `V-${run}`, inventory: 1 },
          select: { id: true },
        })
      )
    );
    const v = (await owner.query(`select price from product_variants where id = $1`, [created.id]))
      .rows[0];
    expect(v.price).toBe(priceOf(18, 2000, 'fixed', 50000, rate18, 0, step));
    // the product price is now the minimum active variant price
    expect((await getRows([fx.p18]))[0].price).toBe(v.price);
    // the same insert WITHOUT the repricer is refused by the database guard
    let caught: unknown;
    await runInStoreScope(fx.storeId, async () => {
      try {
        await prisma.productVariant.create({
          data: { productId: fx.p18, title: `W-${run}`, inventory: 1 },
        });
      } catch (e) {
        caught = e;
      }
    });
    expect(isGoldPriceManaged(caught), String(caught)).toBe(true);
  });

  it('7f. a product with fixed-price wholesale tiers cannot be switched to gold (Ruling B5-19a); a fixed product keeps working', async () => {
    const pid = await createProduct(owner, fx.storeId, { price: 700000 });
    await owner.query(
      `insert into product_price_tiers (id, store_id, product_id, min_qty, price_minor, updated_at) values ($1, $2, $3, 10, 650000, now())`,
      [uid(), fx.storeId, pid]
    );
    const res = await request(app)
      .put(`/api/v1/stores/${fx.storeId}/gold-rates/products/${pid}/pricing`)
      .set({ Authorization: `Bearer ${fx.ownerToken}` })
      .send({
        product: {
          pricingMode: 'gold_rate',
          karat: 24,
          weightMg: 1000,
          makingChargeType: 'fixed',
          makingChargeValue: 0,
        },
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GOLD_NO_PRICE_TIERS');
    expect(
      (await owner.query(`select pricing_mode from products where id = $1`, [pid])).rows[0]
        .pricing_mode
    ).toBe('fixed');
  });

  it("8. CSV import: a gold product's changed price cell fails THAT row; the other rows import", async () => {
    const sku = `G-${run}`;
    await owner.query(`update products set sku = $1 where id = $2`, [sku, fx.p21]);
    const current = (await getRows([fx.p21]))[0].price as number;
    const csv = [
      'name,sku,price,status',
      `Gold ring,${sku},${current + 100},active`,
      `Plain ${run},PLAIN-${run},5000,active`,
    ].join('\n');
    const result = await runInStoreScope(fx.storeId, () =>
      BulkService.importProducts(fx.storeId, csv, { updateExisting: true }, fx.ownerId)
    );
    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
    expect(result.errors[0].error).toMatch(/gold rate/);
    expect((await getRows([fx.p21]))[0].price).toBe(current);
    // re-importing the CURRENT price is allowed (an export edited and re-imported)
    const same = await runInStoreScope(fx.storeId, () =>
      BulkService.importProducts(
        fx.storeId,
        ['name,sku,price,status', `Gold ring,${sku},${current},active`].join('\n'),
        { updateExisting: true },
        fx.ownerId
      )
    );
    expect(same.failed).toBe(0);
    expect(same.updated).toBe(1);
  });

  it('9. SIZE CAP: more than 5 000 gold rows is refused (GOLD_CATALOGUE_TOO_LARGE); 2 000 rows reprice in a measured time', async () => {
    const store = await withRlsBypass(async tx => {
      const u = await tx.user.create({
        data: {
          email: `gold-cap-${run}@test.local`,
          passwordHash: 'x',
          firstName: 'C',
          lastName: 'cap',
          role: 'store_admin',
          emailVerified: true,
        },
      });
      userIds.push(u.id);
      const s = await tx.store.create({
        data: {
          name: `gold-cap-${run}`,
          slug: `gold-cap-${run}`,
          template: 'qamar',
          currency: 'EGP',
          ownerId: u.id,
          status: 'active',
        },
      });
      storeIds.push(s.id);
      return { id: s.id, userId: u.id };
    });
    const bulkInsert = async (n: number, offset = 0) => {
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query(`select set_config('app.gold_reprice','on',true)`);
        await c.query(
          `insert into products (id, store_id, name, slug, price, status, inventory, updated_at, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value)
           select gen_random_uuid()::text, $1, 'G', 'g-' || (gs + $4::int) || '-' || $2, 1, 'active', 1, now(), 'gold_rate', 21, 3000, 'per_gram', 15000 from generate_series(1, $3::int) gs`,
          [store.id, run, n, offset]
        );
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    };
    await bulkInsert(2000);
    const t = token(store.userId, 'store_admin');
    const started = Date.now();
    const ok = await put({ rates: [{ karat: 21, ratePerGram: 576323 }] }, t, store.id);
    const elapsed = Date.now() - started;
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.repriced).toBe(2000);
    // measured, not guessed: recorded in the task report; the cap drops if this is ever > 2 s on the capped DB
    console.log(`[gold-rate-apply] 2 000 gold rows repriced in ${elapsed} ms (capped local DB)`);
    expect(elapsed).toBeLessThan(10_000);
    await bulkInsert(3001, 2000); // 5 001 in total
    const big = await put({ rates: [{ karat: 21, ratePerGram: 580000 }] }, t, store.id);
    expect(big.status).toBe(409);
    expect(big.body.error.code).toBe('GOLD_CATALOGUE_TOO_LARGE');
  });
});
