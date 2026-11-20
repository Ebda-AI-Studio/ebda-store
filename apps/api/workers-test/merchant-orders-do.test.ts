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
      moneyOp(storeId: string, op: string, argsJson: string, key?: string): Promise<DoAnswer>;
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
/** Poll until `fn` is truthy (a write applied off the request). */
async function until<T>(fn: () => Promise<T | null>, ms = 10_000): Promise<T | null> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await new Promise(r => setTimeout(r, 150));
  }
}
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
    async function paidCodOrder(
      buyer: { bearer?: string; phone: string },
      productId: string,
      opts: { method?: 'cod' | 'instapay'; markPaid?: boolean } = {}
    ) {
      const method = opts.method ?? 'cod';
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
          paymentMethod: method,
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
        body: JSON.stringify({ orderId, provider: method }),
      });
      expect(pay.status, await pay.clone().text()).toBe(200);
      if (opts.markPaid === false || method !== 'cod') return orderId;
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
      // and the features the merchant screens below gate on
      for (const key of ['accounting.basic', 'inventory.multi_warehouse', 'coupons'])
        await e.PLATFORM_DB.prepare(
          'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
        )
          .bind(`orders-do-${key}`, storeId, key, Date.now())
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
          {
            model: 'PaymentConfig',
            op: 'create',
            args: {
              data: {
                id: crypto.randomUUID(),
                storeId,
                provider: 'instapay',
                isEnabled: true,
                isDefault: false,
                testMode: true,
                displayName: 'instapay',
                settings: { handle: 'orders@instapay', expiryHours: 24 },
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
    // soft assertions: a red run lists EVERY path that still reaches Postgres, not only the first
    it('merchant writes and reads that touched Postgres now land in the DO (Ruling NZ-MERCHANT-1)', async () => {
      await pgReaches(true);
      const steps: string[] = [];
      const call = async (
        name: string,
        path: string,
        init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
      ) => {
        const r = await api(path, {
          method: init.method ?? 'GET',
          headers: init.headers ?? merchant,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
        const text = await r.text();
        steps.push(`${r.status} ${name} ${r.status >= 400 ? text.slice(0, 200) : ''}`);
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        return { status: r.status, json };
      };
      const S = `/stores/${storeId}`;

      // 1. a variant that holds stock is disabled, then re-enabled: two stock-history rows (variant.service updateVariant)
      const pv = crypto.randomUUID();
      const v1 = crypto.randomUUID();
      const seeded = await e.API.fetch(`${BASE}/internal/store-do/${storeId}/seed`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer workers-test-seed-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          products: [
            {
              id: pv,
              storeId,
              name: 'Ring sizes',
              slug: 'orders-do-sizes',
              price: 7000,
              hasVariants: true,
              status: 'active',
            },
          ],
          variants: [
            { id: v1, productId: pv, sku: 'RING-S7', price: 7000, inventory: 4, isActive: true },
          ],
        }),
      });
      expect(seeded.status, await seeded.clone().text()).toBe(200);
      const off = await call('variant disable', `${S}/products/${pv}/variants/${v1}`, {
        method: 'PUT',
        body: { isActive: false },
      });
      const on = await call('variant re-enable', `${S}/products/${pv}/variants/${v1}`, {
        method: 'PUT',
        body: { isActive: true },
      });
      expect.soft([off.status, on.status], steps.join('\n')).toEqual([200, 200]);
      const hist = await doRead<Array<{ quantity: number; previousStock: number }>>(
        storeId,
        'InventoryHistory',
        { where: { reference: `variant:${v1}` } }
      );
      expect.soft(hist.map(h => [h.quantity, h.previousStock])).toEqual([
        [0, 4],
        [0, 4],
      ]);

      // 2. the SKU search of the warehouse stock list (product-search searchVariantIdsBySku)
      const whs = await call('warehouse create', `${S}/warehouses`, {
        method: 'POST',
        body: { name: 'Main', code: 'MAIN', isDefault: true },
      });
      const wh = whs.json?.data?.id ?? whs.json?.data?.warehouse?.id;
      expect(wh, steps.join('\n')).toBeTruthy();
      {
        const st = await call(
          'warehouse stock search by sku',
          `${S}/warehouses/${wh}/stock?search=ring-s7`
        );
        expect.soft(st.status, steps.join('\n')).toBe(200);
      }

      // 3. a first-order coupon check for a guest phone that already ordered (promotion-resolver order.count, JSON path)
      const coupon = await call('coupon create', `${S}/coupons`, {
        method: 'POST',
        body: {
          code: 'WELCOME10',
          name: 'Welcome',
          type: 'percentage',
          value: 10,
          isActive: true,
          firstOrderOnly: true,
        },
      });
      expect.soft(coupon.status, steps.join('\n')).toBeLessThan(300);
      const validate = await call(
        'coupon validate (guest phone)',
        `/stores/public/${storeId}/coupons/validate`,
        {
          method: 'POST',
          headers: { 'x-store-id': storeId },
          body: {
            code: 'WELCOME10',
            orderTotal: 10_000,
            phone: '+201000000202',
            cartItems: [{ productId: productIds[0], quantity: 2, lineTotal: 10_000 }],
          },
        }
      );
      // that phone already ordered twice: the first-order-only code is refused (400), never a Postgres 500
      expect
        .soft(validate.status, `${steps.join('\n')}\n${JSON.stringify(validate.json)}`)
        .toBe(400);

      const fresh = await call(
        'coupon validate (new phone)',
        `/stores/public/${storeId}/coupons/validate`,
        {
          method: 'POST',
          headers: { 'x-store-id': storeId },
          body: {
            code: 'WELCOME10',
            orderTotal: 10_000,
            phone: '+201000000999',
            cartItems: [{ productId: productIds[0], quantity: 2, lineTotal: 10_000 }],
          },
        }
      );
      expect.soft(fresh.status, `${steps.join('\n')}\n${JSON.stringify(fresh.json)}`).toBe(200);

      // the checkout auto-promotion preview (the live 01:14:48Z POSTGRES_REMOVED on the QA store: order.count in the resolver)
      const preview = await call(
        'promotions preview (guest phone)',
        `/stores/public/${storeId}/promotions/preview`,
        {
          method: 'POST',
          headers: { 'x-store-id': storeId },
          body: { items: [{ productId: productIds[0], quantity: 1 }], phone: '+201000000202' },
        }
      );
      expect.soft(preview.status, steps.join('\n')).toBe(200);

      // 4. a carrier configuration: save, make default, rotate the webhook secret, delete (shipping-carrier.service)
      const put = await call('carrier config save', `${S}/shipping-carriers/configs/bosta`, {
        method: 'PUT',
        body: { settings: { pickupNotes: 'back door' } },
      });
      expect.soft(put.status, steps.join('\n')).toBe(200);
      const def = await call(
        'carrier default (not enabled: 409)',
        `${S}/shipping-carriers/default/bosta`,
        {
          method: 'POST',
          body: {},
        }
      );
      expect.soft(def.status, steps.join('\n')).toBe(409);
      const del = await call('carrier config delete', `${S}/shipping-carriers/configs/bosta`, {
        method: 'DELETE',
      });
      expect.soft(del.status, steps.join('\n')).toBeLessThan(300);
      const carriers = await doRead<unknown[]>(storeId, 'ShippingCarrierConfig', {
        where: { storeId },
      });
      expect.soft(carriers).toEqual([]);

      // 5. pickups of a shipment (shipment-pickup.service): the state read, and a cancel of an unknown pickup is a 404
      const shipmentId = crypto.randomUUID();
      const orders = await doRead<Array<{ id: string }>>(storeId, 'Order', { where: { storeId } });
      const ship = await stub(storeId).mutate(storeId, {
        ops: [
          {
            model: 'Shipment',
            op: 'create',
            args: {
              data: {
                id: shipmentId,
                storeId,
                orderId: orders[0].id,
                carrier: 'bosta',
                status: 'created',
                trackingNumber: 'TRK-ORDERS-DO-1',
                pickupAddress: { city: 'Cairo' },
                deliveryAddress: { city: 'Giza' },
              },
            },
          },
        ],
      });
      expect(ship.ok, JSON.stringify(ship)).toBe(true);
      const pick = await call('pickup state', `${S}/shipments/${shipmentId}/pickup`);
      expect.soft(pick.status, steps.join('\n')).toBe(200);
      const cancel = await call(
        'pickup cancel (unknown)',
        `${S}/shipments/${shipmentId}/pickup/${crypto.randomUUID()}/cancel`,
        { method: 'POST', body: {} }
      );
      expect.soft(cancel.status, steps.join('\n')).toBe(404);

      // 6. a dead-stock flag accepted as a clearance coupon: the coupon and the flag move together; a second click is a 409
      const flagId = crypto.randomUUID();
      const flag = await stub(storeId).mutate(storeId, {
        ops: [
          {
            model: 'DeadStockFlag',
            op: 'create',
            args: {
              data: {
                id: flagId,
                storeId,
                productId: productIds[1],
                status: 'open',
                suggestedDiscountBps: 2500,
                daysSinceSale: 120,
                stockOnHand: 100,
                clearanceCopyEn: 'Last pieces',
              },
            },
          },
        ],
      });
      expect(flag.ok, JSON.stringify(flag)).toBe(true);
      const clr = await call('clearance coupon', `${S}/stock/deadstock-flags/${flagId}/clearance`, {
        method: 'POST',
        body: {},
      });
      expect.soft(clr.status, steps.join('\n')).toBeLessThan(300);
      const again = await call(
        'clearance coupon again',
        `${S}/stock/deadstock-flags/${flagId}/clearance`,
        {
          method: 'POST',
          body: {},
        }
      );
      expect.soft(again.status, steps.join('\n')).toBe(409);
      const flags = await doRead<Array<{ status: string; couponCode: string | null }>>(
        storeId,
        'DeadStockFlag',
        { where: { id: flagId } }
      );
      expect.soft(flags[0].status).toBe('accepted_clearance');

      // 7. a CSV import that carries a barcode (bulk.service: the advisory barcode lock is Postgres-only)
      const imp = await call('bulk import with a barcode', `${S}/bulk/import`, {
        method: 'POST',
        body: {
          csvData: 'name,price,barcode\nPearl studs,3500,6221234567891\n',
          options: {},
        },
      });
      expect.soft(imp.status, steps.join('\n')).toBeLessThan(300);
      // the import runs as a job (202, `bulk-import/started`); the harness does not execute event jobs, so the job body (where
      // the barcode lock sits) runs inline through `/__dev/run-event`, then its product must carry the barcode
      const queued = await doRead<Array<{ id: string; status: string }>>(storeId, 'BulkImportJob', {
        where: { storeId },
      });
      expect.soft(queued.map(j => j.status)).toEqual(['queued']);
      const ran = await e.API.fetch('https://api.ebda.app/__dev/run-event', {
        method: 'POST',
        body: JSON.stringify({
          name: 'bulk-import/started',
          data: { jobId: queued[0].id, storeId },
        }),
      });
      const ranBody = await ran.text();
      expect.soft(ran.status, ranBody).toBe(200);
      expect
        .soft(
          JSON.parse(ranBody).jobs.every((j: { ok: boolean }) => j.ok),
          ranBody
        )
        .toBe(true);
      const done = await doRead<Array<{ status: string; created: number }>>(
        storeId,
        'BulkImportJob',
        {
          where: { id: queued[0].id },
        }
      );
      expect.soft([done[0].status, done[0].created], ranBody).toEqual(['completed', 1]);
      const imported = await doRead<Array<{ barcode: string | null }>>(storeId, 'Product', {
        where: { storeId, name: 'Pearl studs' },
      });
      expect.soft(imported[0]?.barcode).toBe('6221234567891');

      // 8. the super admin suspends and reactivates the store: both audit rows land in the DO (store.routes status)
      await authState('user:tv:super-orders-do', [['set', 'user:tv:super-orders-do', '0', {}]]);
      const su = await accessToken({
        userId: 'super-orders-do',
        jti: 'j-orders-do-su',
        role: 'super_admin',
      });
      const suH = { authorization: `Bearer ${su}` };
      const sus = await call('store suspend', `/stores/${storeId}/status`, {
        method: 'PATCH',
        headers: suH,
        body: { status: 'suspended' },
      });
      const act = await call('store reactivate', `/stores/${storeId}/status`, {
        method: 'PATCH',
        headers: suH,
        body: { status: 'active' },
      });
      expect.soft([sus.status, act.status], steps.join('\n')).toEqual([200, 200]);
      const audits = await until(async () => {
        const rows = await doRead<Array<{ action: string }>>(storeId, 'AuditLog', {
          where: { storeId, resourceType: 'store' },
        });
        return rows.length >= 2 ? rows : null;
      });
      expect
        .soft((audits ?? []).map(a => a.action).sort())
        .toEqual(['store.reactivate', 'store.suspend']);

      // 9. the payment events of the merchant's mark-paid (payment-event.service recordPaymentEvent, swallowed before)
      const events = await doRead<Array<{ eventType: string }>>(storeId, 'PaymentEvent', {
        where: { storeId },
      });
      expect
        .soft(events.length, 'mark-paid records a payment event per order')
        .toBeGreaterThanOrEqual(5);

      expect.soft(reachReport(await pgReaches(true)), steps.join('\n')).toBe('');
    }, 120_000);
    it('money: InstaPay refund record, refund match-claim, WhatsApp COD outcome on a DO store (Ruling NZ-MONEY-6)', async () => {
      await pgReaches(true);
      const steps: string[] = [];
      const S = `/stores/${storeId}`;
      const post = async (name: string, path: string, body: unknown) => {
        const r = await api(path, {
          method: 'POST',
          headers: merchant,
          body: JSON.stringify(body),
        });
        const text = await r.text();
        steps.push(`${r.status} ${name} ${r.status >= 400 ? text.slice(0, 200) : ''}`);
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        return { status: r.status, json };
      };
      const payRow = async (orderId: string) =>
        (
          await doRead<Array<{ status: string; refundedAmount: number; amount: number }>>(
            storeId,
            'Payment',
            {
              where: { orderId, provider: 'instapay' },
            }
          )
        )[0];
      const orderOf = async (orderId: string) =>
        (
          await doRead<Array<{ status: string; paymentStatus: string }>>(storeId, 'Order', {
            where: { id: orderId },
          })
        )[0];

      // 1. an InstaPay order the merchant confirmed (the confirm is the DO op the confirm route calls)
      const ipOrder = await paidCodOrder({ phone: '+201000000404' }, productIds[0], {
        method: 'instapay',
      });
      const conf = await stub(storeId).moneyOp(
        storeId,
        'confirmPayment',
        JSON.stringify({ orderId: ipOrder })
      );
      expect(conf.ok, JSON.stringify(conf)).toBe(true);
      const paid = await payRow(ipOrder);
      expect(paid?.status).toBe('completed');
      const refund = (reference: string, amountMinor: number) =>
        post(
          `instapay refund ${reference} ${amountMinor}`,
          `${S}/orders/${ipOrder}/instapay-refund`,
          {
            reference,
            refundDate: '2026-11-10',
            refundTime: '12:00',
            recipientName: 'N*** B***',
            amountMinor,
          }
        );
      const part = await refund('11112222', 1000);
      expect.soft(part.status, steps.join('\n')).toBeLessThan(300);
      const replay = await refund('11112222', 1000);
      expect
        .soft([replay.status < 300, replay.json?.data?.duplicate], steps.join('\n'))
        .toEqual([true, true]);
      expect
        .soft((await payRow(ipOrder))?.refundedAmount, 'a replay never refunds twice')
        .toBe(1000);
      const over = await refund('33334444', paid.amount);
      expect.soft(over.status, steps.join('\n')).toBe(400);
      const rest = await refund('55556666', paid.amount - 1000);
      expect.soft(rest.status, steps.join('\n')).toBeLessThan(300);
      expect
        .soft(await payRow(ipOrder))
        .toMatchObject({ status: 'refunded', refundedAmount: paid.amount });
      expect
        .soft(await orderOf(ipOrder))
        .toMatchObject({ status: 'refunded', paymentStatus: 'refunded' });
      const done = await refund('77778888', 1);
      expect.soft(done.status, steps.join('\n')).toBe(409);

      // 2. refund match-claim with a claim that does not exist on this order: a refusal, never a Postgres 500
      const match = await post(
        'refund match-claim (unknown claim)',
        `${S}/orders/${ipOrder}/refund-match-claim`,
        {
          claimId: crypto.randomUUID(),
          providerRefundId: 'rf_unknown',
        }
      );
      expect.soft([404, 409], steps.join('\n')).toContain(match.status);

      // 3. WhatsApp COD answers on open COD orders: refused -> cancelled, confirmed -> confirmed; a chat order of an erased buyer -> cancelled
      const wa = async (type: string, data: Record<string, unknown>) => {
        const r = await e.API.fetch('https://api.ebda.app/__dev/wa-store-event', {
          method: 'POST',
          body: JSON.stringify({
            id: crypto.randomUUID(),
            v: 1,
            storeId,
            occurredAt: new Date().toISOString(),
            type,
            data,
          }),
        });
        const text = await r.text();
        steps.push(`${r.status} wa ${type} ${text.slice(0, 200)}`);
        return text;
      };
      const refusedOrder = await paidCodOrder({ phone: '+201000000505' }, productIds[1], {
        markPaid: false,
      });
      const confirmedOrder = await paidCodOrder({ phone: '+201000000606' }, productIds[1], {
        markPaid: false,
      });
      const erasedOrder = await paidCodOrder({ phone: '+201000000707' }, productIds[1], {
        markPaid: false,
      });
      // the store is linked to Ebda Chat with an active package (an unlinked store's events are ignored by design)
      const link = await stub(storeId).mutate(storeId, {
        ops: [
          {
            model: 'StoreWhatsAppLink',
            op: 'create',
            args: {
              data: {
                storeId,
                linked: true,
                ownerUserId: owner,
                linkedAt: new Date(),
                entitlementVersion: 1,
                entitlementPackageId: 'pkg-test',
                entitlementAutomation: true,
                entitlementStatus: 'active',
                entitlementValidUntil: new Date(Date.now() + 30 * 24 * 3600_000),
              },
            },
          },
        ],
      });
      expect(link.ok, JSON.stringify(link)).toBe(true);
      expect
        .soft(
          await wa('whatsapp.cod_outcome', {
            orderId: refusedOrder,
            outcome: 'refused',
            source: 'whatsapp',
          })
        )
        .toContain('applied');
      expect
        .soft(
          await wa('whatsapp.cod_outcome', {
            orderId: confirmedOrder,
            outcome: 'confirmed',
            source: 'whatsapp',
          })
        )
        .toContain('applied');
      expect
        .soft(
          await wa('whatsapp.order_after_erasure', {
            orderId: erasedOrder,
            buyerKey: 'a'.repeat(64),
          })
        )
        .toContain('applied');
      expect.soft((await orderOf(refusedOrder))?.status).toBe('cancelled');
      expect.soft((await orderOf(confirmedOrder))?.status).toBe('confirmed');
      expect.soft((await orderOf(erasedOrder))?.status).toBe('cancelled');
      // a late "confirmed" on the cancelled order changes nothing
      expect
        .soft(
          await wa('whatsapp.cod_outcome', {
            orderId: refusedOrder,
            outcome: 'confirmed',
            source: 'whatsapp',
          })
        )
        .toContain('ignored');

      expect.soft(reachReport(await pgReaches(true)), steps.join('\n')).toBe('');
    }, 120_000);
    it('SUSPEND-AI-1: an admin-suspended store is refused AI spend on its Durable Object, and obeyed on the very next call after reactivation', async () => {
      await pgReaches(true);
      await authState('user:tv:super-ai-susp', [['set', 'user:tv:super-ai-susp', '0', {}]]);
      const su = await accessToken({
        userId: 'super-ai-susp',
        jti: 'j-ai-susp-su',
        role: 'super_admin',
      });
      const status = (to: string) =>
        api(`/stores/${storeId}/status`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${su}` },
          body: JSON.stringify({ status: to }),
        });
      const ai = async () => {
        const r = await api(`/stores/${storeId}/ai/seo`, {
          method: 'POST',
          headers: merchant,
          body: JSON.stringify({ kind: 'store' }),
        });
        return { status: r.status, body: await r.text() };
      };
      const sus = await status('suspended');
      expect(sus.status, await sus.clone().text()).toBe(200);
      try {
        const refused = await ai();
        expect(refused.status, refused.body).toBe(403);
        expect(refused.body).toContain('STORE_AI_SUSPENDED');
      } finally {
        const act = await status('active');
        expect(act.status, await act.clone().text()).toBe(200);
      }
      // reactivated: the very next call is no longer refused for the suspension (it goes on to the model / its own checks)
      const after = await ai();
      expect(after.body).not.toContain('STORE_AI_SUSPENDED');
    }, 120_000);
    it('a COD "refused" racing the merchant ship never cancels or restocks a shipped order (Fixes #614)', async () => {
      await pgReaches(true);
      const steps: string[] = [];
      const pid = crypto.randomUUID();
      const seeded = await e.API.fetch(`${BASE}/internal/store-do/${storeId}/seed`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer workers-test-seed-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          products: [
            {
              id: pid,
              storeId,
              name: 'Race ring',
              slug: 'race-ring',
              price: 4000,
              inventory: 50,
              status: 'active',
            },
          ],
        }),
      });
      expect(seeded.status, await seeded.clone().text()).toBe(200);
      const status = async (orderId: string, to: string) => {
        const r = await api(`/stores/${storeId}/orders/${orderId}/status`, {
          method: 'PUT',
          headers: merchant,
          body: JSON.stringify({ status: to }),
        });
        const text = await r.text();
        steps.push(
          `${r.status} ${to} ${orderId.slice(0, 8)} ${r.status >= 300 ? text.slice(0, 160) : ''}`
        );
        return r.status;
      };
      const refuse = async (orderId: string) => {
        const r = await e.API.fetch('https://api.ebda.app/__dev/wa-store-event', {
          method: 'POST',
          body: JSON.stringify({
            id: crypto.randomUUID(),
            v: 1,
            storeId,
            occurredAt: new Date().toISOString(),
            type: 'whatsapp.cod_outcome',
            data: { orderId, outcome: 'refused', source: 'whatsapp' },
          }),
        });
        const text = await r.text();
        steps.push(`${r.status} refused ${orderId.slice(0, 8)} ${text.slice(0, 120)}`);
        return text;
      };
      const order = async (orderId: string) =>
        (
          await doRead<Array<{ status: string; notes: string | null }>>(storeId, 'Order', {
            where: { id: orderId },
          })
        )[0];
      const stock = async () =>
        (await doRead<Array<{ inventory: number }>>(storeId, 'Product', { where: { id: pid } }))[0]
          .inventory;

      // 1. deterministic: shipped first, then the refusal: nothing moves but the merchant's note
      const first = await paidCodOrder({ phone: '+201000000801' }, pid, { markPaid: false });
      expect(await status(first, 'confirmed'), steps.join('\n')).toBeLessThan(300);
      expect(await status(first, 'shipped'), steps.join('\n')).toBeLessThan(300);
      const before = await stock();
      await refuse(first);
      const o1 = await order(first);
      expect.soft(o1.status, steps.join('\n')).toBe('shipped');
      expect
        .soft(o1.notes ?? '', 'the refusal is a delivery exception for the merchant')
        .toContain('Delivery exception');
      expect.soft(await stock(), 'no restock of a shipped order').toBe(before);

      // 1b. the stale read, made deterministic: the consumer read 'confirmed', then the ship landed, then its cancel reached
      //     the DO. The DO op itself must refuse in its own section (the Worker-side read cannot protect this).
      const stale = await paidCodOrder({ phone: '+201000000802' }, pid, { markPaid: false });
      expect(await status(stale, 'confirmed'), steps.join('\n')).toBeLessThan(300);
      expect(await status(stale, 'shipped'), steps.join('\n')).toBeLessThan(300);
      const beforeStale = await stock();
      const op = await stub(storeId).moneyOp(
        storeId,
        'cancel',
        JSON.stringify({
          orderId: stale,
          onlyFrom: ['pending', 'confirmed'],
          exceptionNote: 'Delivery exception: refused after it shipped',
        })
      );
      steps.push(`do cancel onlyFrom on shipped: ${JSON.stringify(op).slice(0, 200)}`);
      expect.soft((await order(stale)).status, steps.join('\n')).toBe('shipped');
      expect.soft(await stock(), 'the DO guard: no restock').toBe(beforeStale);

      // 2. race: the ship and the refusal sent at the same moment, five times. Whichever the DO runs first wins:
      //    cancelled (and restocked) OR shipped with the note (and NOT restocked), never shipped AND restocked.
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await paidCodOrder({ phone: `+20100000090${i}` }, pid, { markPaid: false });
        expect(await status(id, 'confirmed'), steps.join('\n')).toBeLessThan(300);
        ids.push(id);
      }
      const start = await stock();
      await Promise.all(ids.flatMap(id => [status(id, 'shipped'), refuse(id)]));
      let cancelled = 0;
      for (const id of ids) {
        const o = await order(id);
        if (o.status === 'cancelled') cancelled++;
        else {
          expect.soft(o.status, steps.join('\n')).toBe('shipped');
          expect
            .soft(o.notes ?? '', `${id} shipped: noted, not cancelled`)
            .toContain('Delivery exception');
        }
      }
      // every order holds 2 units: only the cancelled ones came back to stock
      expect.soft(await stock(), steps.join('\n')).toBe(start + 2 * cancelled);
      expect.soft(reachReport(await pgReaches(true)), steps.join('\n')).toBe('');
    }, 120_000);
  }
);
