/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * A merchant's daily screens on a Durable Object store that HAS orders and customers, Postgres absent (every Prisma call
 * throws POSTGRES_REMOVED). The built Worker, every cutover marker set, a store on D1 + its StoreDO, a registered customer and
 * guests placing real COD orders through the storefront API, the merchant marking them paid: then the merchant surfaces that
 * read or write those orders must answer from the DO with no access to the Postgres client (`/__dev/pg-reaches`).
 *
 *   - insights: /insights/dashboard (AOV, revenue, repeat-purchase rate, top SKUs), cohorts, funnel, segments, products,
 *     the RFM batch and one customer's RFM (Ruling NZ-INSIGHTS-1), and the other admin dashboard cards (analytics, finance,
 *     customers)
 *
 * Run: npm run -w apps/api cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/merchant-orders-do.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';

type DoAnswer = { ok: true; json: string } | { ok: false; code: string; message?: string };

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): {
      bind(...v: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null> };
    };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: {
    idFromName(n: string): unknown;
    get(id: unknown): {
      mutate(storeId: string, m: unknown): Promise<DoAnswer>;
      query(storeId: string, q: unknown[]): Promise<DoAnswer>;
    };
  };
};

const BASE = 'https://api.ebda.app/api/v1';
const MARKER_KEYS = [
  'platform_cutover.billing',
  'platform_cutover.access',
  'platform_cutover.platform',
  'platform_cutover.inbox',
  'platform_cutover.ai-usage',
  'platform_cutover.analytics',
  'platform_cutover.payments',
  'platform_cutover.ops',
  'platform_cutover.audit',
  'customer_auth_cutover.__all',
];

let ip = 0;
const freshIp = () => `10.78.${(ip >> 8) & 255}.${ip++ & 255}`;
const stub = (storeId: string) => e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
const unwrap = <T>(a: DoAnswer): T => {
  if (!a.ok) throw new Error(`DO refused: ${a.code} ${a.message ?? ''}`);
  return JSON.parse(a.json) as T;
};
async function doRead<T>(storeId: string, model: string, args: Record<string, unknown>) {
  return unwrap<T[]>(await stub(storeId).query(storeId, [{ model, op: 'findMany', args }]))[0];
}
async function pgReaches(reset = false): Promise<Array<{ label: string; stack: string }>> {
  const r = await e.API.fetch(`https://api.ebda.app/__dev/pg-reaches${reset ? '?reset=1' : ''}`);
  return ((await r.json()) as { reaches: Array<{ label: string; stack: string }> }).reaches;
}
const api = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  e.API.fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'cf-connecting-ip': freshIp(),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
/** The Postgres reaches since the last reset, as readable lines (label + the first app frame). */
const reachReport = (r: Array<{ label: string; stack: string }>) =>
  r.map(x => `${x.label} @ ${x.stack.split('\n').find(l => l.includes('/src/')) ?? ''}`).join('\n');

describe.skipIf(e.E2E_DB === '1')(
  'merchant screens of a Durable Object store with orders and customers, Postgres absent',
  () => {
    let storeId = '';
    const productIds: string[] = [];
    const owner = 'owner-orders-do';
    const customerId = 'cust-orders-do-1';
    let merchant: Record<string, string> = {};
    let nSession = 0;

    /** A real storefront checkout (cart line, POST /public/orders, COD payment row), then the merchant marks it paid. */
    async function paidCodOrder(buyer: { bearer?: string; phone: string }, productId: string) {
      const h: Record<string, string> = {
        'x-store-id': storeId,
        'x-session-id': `sess-orders-do-${++nSession}`,
        ...(buyer.bearer ? { authorization: `Bearer ${buyer.bearer}` } : {}),
      };
      const add = await api('/public/cart/items', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ productId, quantity: 2 }),
      });
      expect(add.status, await add.clone().text()).toBeLessThan(300);
      const res = await api('/public/orders', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          paymentMethod: 'cod',
          shippingAddress: {
            firstName: 'Nour',
            lastName: 'Buyer',
            address1: '1 Test St',
            city: 'Cairo',
            phone: buyer.phone,
            country: 'EG',
          },
        }),
      });
      const text = await res.text();
      expect(res.status, text).toBeLessThan(300);
      const j = JSON.parse(text) as { data: { id?: string; order?: { id: string } } };
      const orderId = j.data.order?.id ?? j.data.id!;
      const pay = await api('/payments/create', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ orderId, provider: 'cod' }),
      });
      expect(pay.status, await pay.clone().text()).toBe(200);
      const paid = await api(`/stores/${storeId}/orders/${orderId}/mark-paid`, {
        method: 'POST',
        headers: merchant,
        body: JSON.stringify({}),
      });
      expect(paid.status, await paid.clone().text()).toBeLessThan(300);
      return orderId;
    }

    it('fixture: a DO store, a registered customer and guests with paid orders', async () => {
      await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
      for (const p of DEFAULT_PLAN_SEEDS)
        await e.PLATFORM_DB.prepare(
          'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
        )
          .bind(
            `plan-${p.code}`,
            p.code,
            p.nameEn,
            p.nameAr,
            p.featureTier,
            JSON.stringify(p.limits),
            p.priceMonthlyMinor,
            p.priceYearlyMinor
          )
          .run();
      for (const [i, k] of MARKER_KEYS.entries())
        await e.PLATFORM_DB.prepare(
          'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
        )
          .bind(`orders-do-marker-${i}`, k)
          .run();
      const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
        method: 'POST',
        body: JSON.stringify({
          ownerId: owner,
          name: 'Orders Shop',
          slug: 'orders-do-shop',
          operator: true,
        }),
      });
      expect(created.status).toBe(200);
      storeId = ((await created.json()) as { id: string }).id;
      // before any request (the plan answer is cached): a plan whose analytics tier is `advanced` (the insights pages gate on it)
      await e.PLATFORM_DB.prepare(
        "UPDATE store_subscriptions SET plan_code = 'pro', status = 'active' WHERE store_id = ?1"
      )
        .bind(storeId)
        .run();
      // the merchant switched on the basic books (the performance + cash-flow cards gate on it)
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
      )
        .bind('orders-do-accounting', storeId, 'accounting.basic', Date.now())
        .run();
      for (const u of [owner, customerId])
        await authState(`user:tv:${u}`, [['set', `user:tv:${u}`, '0', {}]]);
      const sa = await accessToken({
        userId: owner,
        jti: 'j-orders-do-owner',
        role: 'store_admin',
        storeId,
      });
      merchant = { authorization: `Bearer ${sa}`, 'x-store-id': storeId };

      const wrote = await stub(storeId).mutate(storeId, {
        ops: [
          {
            model: 'PaymentConfig',
            op: 'create',
            args: {
              data: {
                id: crypto.randomUUID(),
                storeId,
                provider: 'cod',
                isEnabled: true,
                isDefault: true,
                testMode: true,
                displayName: 'cod',
              },
            },
          },
        ],
      });
      expect(wrote.ok, JSON.stringify(wrote)).toBe(true);

      const now = Date.now();
      for (const [i, name] of ['Gold ring', 'Silver chain'].entries()) {
        const id = crypto.randomUUID();
        productIds.push(id);
        const seeded = await e.API.fetch(`${BASE}/internal/store-do/${storeId}/seed`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer workers-test-seed-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            products: [
              {
                id,
                storeId,
                name,
                nameAr: i === 0 ? 'خاتم ذهب' : 'سلسلة فضة',
                slug: `orders-do-${i}`,
                sku: `SKU-${i}`,
                price: 5000 + i * 1000,
                costPrice: 2000,
                inventory: 100,
                status: 'active',
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
        });
        expect(seeded.status, await seeded.clone().text()).toBe(200);
      }

      // A registered customer (two orders: a repeat buyer), guest A (two orders, same phone: a repeat buyer), guest B (one).
      const customer = await accessToken({
        userId: customerId,
        jti: 'j-orders-do-cust',
        role: 'customer',
        storeId,
      });
      await paidCodOrder({ bearer: customer, phone: '+201000000101' }, productIds[0]);
      await paidCodOrder({ bearer: customer, phone: '+201000000101' }, productIds[1]);
      await paidCodOrder({ phone: '+201000000202' }, productIds[0]);
      await paidCodOrder({ phone: '+201000000202' }, productIds[0]);
      await paidCodOrder({ phone: '+201000000303' }, productIds[1]);
      const orders = await doRead<Array<{ customerId: string | null; paymentStatus: string }>>(
        storeId,
        'Order',
        { where: { storeId } }
      );
      expect(orders.length).toBe(5);
      expect(orders.filter(o => o.paymentStatus === 'paid').length).toBe(5);
      expect(orders.filter(o => o.customerId === customerId).length).toBe(2);
    }, 180_000);

    it('insights: the dashboard cards and every insights page answer from the DO (Ruling NZ-INSIGHTS-1)', async () => {
      await pgReaches(true);
      const get = async (path: string) => {
        const r = await api(`/stores/${storeId}${path}`, { headers: merchant });
        return { path, status: r.status, body: await r.text() };
      };
      const dash = await get('/insights/dashboard');
      expect(dash.status, dash.body).toBe(200);
      const d = JSON.parse(dash.body).data;
      expect(d.orderCount30d).toBe(5);
      // 2 x 5000 + 2 x 6000 + 2 x 5000 + 2 x 5000 + 2 x 6000 (+ shipping, if any): at least the lines
      expect(d.mrr30d).toBeGreaterThanOrEqual(54_000);
      // three identifiable buyers (customer id, two guest phones), two of them bought twice
      expect(d.repeatPurchaseBuyers).toBe(3);
      expect(d.repeatPurchaseRate).toBeCloseTo(2 / 3, 5);
      expect(d.topSkus.map((s: { productId: string }) => s.productId).sort()).toEqual(
        [...productIds].sort()
      );
      expect(
        d.topSkus.find((s: { productId: string }) => s.productId === productIds[0]).nameAr
      ).toBe('خاتم ذهب');

      const products = await get('/insights/products');
      expect(products.status, products.body).toBe(200);
      expect(products.body).toContain(productIds[0]);

      const rest = await Promise.all(
        [
          '/insights/cohorts',
          '/insights/funnel',
          '/insights/segments',
          '/insights/customers/rfm-batch',
          // the other cards of the admin dashboard and the analytics page
          ...[
            'dashboard',
            'sales',
            'top-products',
            'top-categories',
            'orders-by-status',
            'customers',
            'recent-orders',
            'low-stock',
            'payment-status',
            'price-source',
            'performance',
            'cashflow',
          ].map(x => `/analytics/${x}`),
          '/analytics/stock-snapshot',
          '/finance/dashboard',
          '/customers',
        ].map(get)
      );
      for (const r of rest) expect(r.status, `${r.path} ${r.body}`).toBe(200);
      // no RFM snapshot yet for this customer (the nightly rollup has not run): a 404, never a Postgres 500
      const rfm = await get(`/insights/customers/${customerId}/rfm`);
      expect(rfm.status, rfm.body).toBe(404);

      expect(reachReport(await pgReaches(true))).toBe('');
    }, 60_000);
  }
);
