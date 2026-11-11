/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * The merchant-admin MCP surface and its API keys on a Durable Object store that HAS orders and customers, Postgres absent (every Prisma call
 * throws POSTGRES_REMOVED). The built Worker, every cutover marker set, a store on D1 + its StoreDO, a registered customer and
 * guests placing real COD orders through the storefront API, the merchant marking them paid: then the merchant surfaces that
 * read or write those orders must answer from the DO with no access to the Postgres client (`/__dev/pg-reaches`).
 *
 *   - merchant API keys: list, mint, revoke (routes/merchant-key.routes.ts, D1 table + DO store scope)
 *   - the admin MCP endpoint (POST /api/v1/mcp/admin/:slug) driven with a minted key: read tools (orders, customers,
 *     marketing), a write tool (merchant-write.ts) and an agent order tool (Ruling NZ-MCP-1)
 *
 * Run: npm run -w apps/api cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/merchant-mcp-do.test.ts
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
const freshIp = () => `10.79.${(ip >> 8) & 255}.${ip++ & 255}`;
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
  'merchant MCP + API keys on a Durable Object store with orders and customers, Postgres absent',
  () => {
    let storeId = '';
    const productIds: string[] = [];
    const owner = 'owner-mcp-do';
    const customerId = 'cust-mcp-do-1';
    let merchant: Record<string, string> = {};
    let nSession = 0;

    /** A real storefront checkout (cart line, POST /public/orders, COD payment row), then the merchant marks it paid. */
    async function paidCodOrder(buyer: { bearer?: string; phone: string }, productId: string) {
      const h: Record<string, string> = {
        'x-store-id': storeId,
        'x-session-id': `sess-mcp-do-${++nSession}`,
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
          .bind(`mcp-do-marker-${i}`, k)
          .run();
      const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
        method: 'POST',
        body: JSON.stringify({
          ownerId: owner,
          name: 'MCP Shop',
          slug: 'mcp-do-shop',
          operator: true,
        }),
      });
      expect(created.status).toBe(200);
      storeId = ((await created.json()) as { id: string }).id;
      // before any request (the plan answer is cached): the Growth plan (merchant_mcp is Growth + Business)
      await e.PLATFORM_DB.prepare(
        "UPDATE store_subscriptions SET plan_code = 'growth', status = 'active' WHERE store_id = ?1"
      )
        .bind(storeId)
        .run();
      // the merchant switched on the basic books (the performance + cash-flow cards gate on it)
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
      )
        .bind('mcp-do-accounting', storeId, 'accounting.basic', Date.now())
        .run();
      // The agent-key MINT and the StoreCredential row are not on the DO yet (STORE_RECORD_REFUSED / MODEL_NOT_WRITABLE), so
      // the key-less grant is used (set before any request, the feature map is cached): the store's own `agent_checkout_open_writes` override (merchant-switched, same write gate).
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
      )
        .bind('mcp-do-open-writes', storeId, 'agent_checkout_open_writes', Date.now())
        .run();

      for (const u of [owner, customerId])
        await authState(`user:tv:${u}`, [['set', `user:tv:${u}`, '0', {}]]);
      const sa = await accessToken({
        userId: owner,
        jti: 'j-mcp-do-owner',
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
                slug: `mcp-do-${i}`,
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
        jti: 'j-mcp-do-cust',
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

    let plaintext = '';
    let keyId = '';

    /** One JSON-RPC tools/call against the admin MCP endpoint (answer is JSON or one SSE frame). */
    async function mcp(tool: string, args: Record<string, unknown>, key = plaintext) {
      const r = await api('/mcp/admin/mcp-do-shop', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          host: 'api.ebda.app',
          'x-merchant-key': key,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      });
      const text = await r.text();
      const frame = text.startsWith('{')
        ? text
        : (text.split('\n').find(l => l.startsWith('data:')) ?? 'data: {}').slice(5);
      const body = JSON.parse(frame) as {
        result?: { isError?: boolean; content?: Array<{ text: string }> };
        error?: unknown;
      };
      return { status: r.status, text, body };
    }

    it('keys: mint (write switch on), list and the key authenticates on the DO store', async () => {
      await pgReaches(true);
      const sw = await api(`/stores/${storeId}/integrations/merchant-mcp/write-switch`, {
        method: 'PUT',
        headers: merchant,
        body: JSON.stringify({ enabled: true }),
      });
      expect(sw.status, await sw.clone().text()).toBeLessThan(300);
      const minted = await api(`/stores/${storeId}/integrations/merchant-keys`, {
        method: 'POST',
        headers: merchant,
        body: JSON.stringify({
          name: 'ci key',
          scopes: ['merchant:read', 'merchant:write'],
        }),
      });
      const mt = await minted.text();
      expect(minted.status, mt).toBeLessThan(300);
      const m = JSON.parse(mt).data as { id: string; apiKey: string };
      plaintext = m.apiKey;
      keyId = m.id;
      expect(plaintext, mt).toBeTruthy();
      const list = await api(`/stores/${storeId}/integrations/merchant-keys`, {
        headers: merchant,
      });
      const lt = await list.text();
      expect(list.status, lt).toBe(200);
      const l = JSON.parse(lt).data;
      expect(l.storeSlug).toBe('mcp-do-shop');
      expect(l.keys.map((k: { id: string }) => k.id)).toContain(keyId);
      expect(reachReport(await pgReaches(true))).toBe('');
    }, 60_000);

    it('read tools: orders, customers and marketing answer from the DO', async () => {
      await pgReaches(true);
      const calls: Array<[string, Record<string, unknown>]> = [
        ['admin_get_store', {}],
        ['admin_list_orders', { limit: 10 }],
        ['admin_get_analytics', {}],
        ['admin_list_customers', { limit: 10 }],
        ['admin_get_funnel', {}],
        ['admin_list_coupons', {}],
        ['admin_list_reviews', {}],
      ];
      for (const [tool, args] of calls) {
        const r = await mcp(tool, args);
        expect(r.status, `${tool} ${r.text}`).toBeLessThan(500);
        expect(r.body.result?.isError, `${tool} ${r.text}`).not.toBe(true);
      }
      const orders = await mcp('admin_list_orders', { limit: 10 });
      expect(orders.body.result?.content, `${orders.status} ${orders.text}`).toBeTruthy();
      const first = JSON.parse(orders.body.result!.content![0].text).orders as Array<{
        id: string;
      }>;
      expect(first.length).toBe(5);
      const one = await mcp('admin_get_order', { orderId: first[0].id });
      expect(one.body.result?.isError, one.text).not.toBe(true);
      expect(reachReport(await pgReaches(true))).toBe('');
    }, 60_000);

    it('write tool: admin_create_coupon through merchant-write lands in the DO', async () => {
      await pgReaches(true);
      const r = await mcp('admin_create_coupon', {
        coupon: { code: 'MCPDO10', name: 'MCP DO ten', type: 'percentage', value: 10 },
      });
      expect(r.status, r.text).toBeLessThan(500);
      expect(r.body.result?.isError, r.text).not.toBe(true);
      const rows = await doRead<{ code: string }>(storeId, 'Coupon', { where: { storeId } });
      expect(rows.map(c => c.code)).toContain('MCPDO10');
      expect(reachReport(await pgReaches(true))).toBe('');
    }, 60_000);

    it('agent order tool: get_order_status on the buyer MCP endpoint answers', async () => {
      await pgReaches(true);
      const [o] = await doRead<{ id: string }>(storeId, 'Order', { where: { storeId }, take: 1 });
      const r = await api('/mcp/mcp-do-shop', {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', host: 'api.ebda.app' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_order_status', arguments: { orderId: o.id } },
        }),
      });
      expect(r.status, await r.clone().text()).toBeLessThan(500);
      expect(reachReport(await pgReaches(true))).toBe('');
    }, 60_000);

    it('agent place_order (cod): one cod_pending payment + created event in the DO, a replay adds none (Ruling NZ-MONEY-AGENT-1)', async () => {
      await pgReaches(true);
      const buyer = async (tool: string, args: Record<string, unknown>) => {
        const r = await api('/mcp/mcp-do-shop', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            host: 'api.ebda.app',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: tool, arguments: args },
          }),
        });
        const text = await r.text();
        const frame = text.startsWith('{')
          ? text
          : (text.split('\n').find(l => l.startsWith('data:')) ?? 'data: {}').slice(5);
        const body = JSON.parse(frame) as {
          result?: { isError?: boolean; content?: Array<{ text: string }> };
        };
        return { status: r.status, text, body };
      };

      const ordersBefore = (await doRead<{ id: string }>(storeId, 'Order', { where: { storeId } }))
        .length;
      const cart = await buyer('add_to_cart', { productId: productIds[0], quantity: 1 });
      expect(cart.status, cart.text).toBeLessThan(500);
      expect(cart.body.result?.isError, cart.text).not.toBe(true);
      const cartId = JSON.parse(cart.body.result!.content![0].text).cartId as string;
      const place = {
        cartId,
        paymentMethod: 'cod',
        customer: {
          name: 'Agent Buyer',
          phone: '+201000000909',
          email: 'agent-buyer@example.com',
          address: '1 Agent St',
          city: 'Cairo',
        },
      };
      const first = await buyer('place_order', place);
      expect(first.status, first.text).toBeLessThan(500);
      expect(first.body.result?.isError, first.text).not.toBe(true);

      const orders = await doRead<{ id: string; customerId: string | null }>(storeId, 'Order', {
        where: { storeId },
      });
      expect(orders.length).toBe(ordersBefore + 1);
      const known = new Set(
        (await doRead<{ orderId: string }>(storeId, 'Payment', { where: { provider: 'cod' } })).map(
          p => p.orderId
        )
      );
      const fresh = orders.find(o => !known.has(o.id));
      expect(fresh, 'the agent order has a cod payment row').toBeUndefined();
      const pays = await doRead<{ id: string; orderId: string; status: string }>(
        storeId,
        'Payment',
        { where: { provider: 'cod', status: 'cod_pending' } }
      );
      expect(pays.length).toBe(1);
      const events = await doRead<{ paymentId: string; eventType: string }>(
        storeId,
        'PaymentEvent',
        { where: { paymentId: pays[0].id } }
      );
      expect(events.filter(e => e.eventType === 'created').length).toBe(1);

      // the same call again: the cart is gone (EMPTY_CART), and no second payment or order appears
      const second = await buyer('place_order', place);
      expect(second.status, second.text).toBeLessThan(500);
      const paysAfter = await doRead<{ id: string }>(storeId, 'Payment', {
        where: { orderId: pays[0].orderId },
      });
      expect(paysAfter.length).toBe(1);
      expect((await doRead(storeId, 'Order', { where: { storeId } })).length).toBe(
        ordersBefore + 1
      );
      expect(reachReport(await pgReaches(true))).toBe('');
    }, 60_000);

    it('keys: revoke, then the key is refused (404) and the list shows it revoked', async () => {
      await pgReaches(true);
      const del = await api(`/stores/${storeId}/integrations/merchant-keys/${keyId}`, {
        method: 'DELETE',
        headers: merchant,
      });
      expect(del.status, await del.clone().text()).toBe(200);
      const after = await mcp('admin_get_store', {});
      expect(after.status).toBe(404);
      const list = await api(`/stores/${storeId}/integrations/merchant-keys`, {
        headers: merchant,
      });
      const l = JSON.parse(await list.text()).data;
      expect(l.keys.find((k: { id: string }) => k.id === keyId).active).toBe(false);
      expect(reachReport(await pgReaches(true))).toBe('');
    }, 60_000);
  }
);
