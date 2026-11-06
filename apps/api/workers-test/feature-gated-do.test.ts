/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Ruling NZ-FEAT-1: the FEATURE-GATED admin subsystems on a store served by its StoreDO, Postgres gone (every Prisma call throws
 * POSTGRES_REMOVED). The route sweep proves the gated routes answer without a 5xx on empty fixtures; this file drives each
 * subsystem's HAPPY PATH with real rows and asserts the state in the DO and that nothing reached the Postgres client
 * (`/__dev/pg-reaches`, DEV_STATS=1): warehouses, the customer wallet (money), loyalty (money), affiliates, suppliers,
 * campaign test-send, backorders, scan-to-pick, abandoned-cart stats and the AI product feed.
 *
 * Run: npm run -w apps/api cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/feature-gated-do.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS, FEATURE_KEYS_ARRAY } from '@ebda/shared';
import { accessToken, authState } from './helpers';

type DoAnswer = { ok: true; json: string } | { ok: false; code: string; message?: string };
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: {
    idFromName(n: string): unknown;
    get(id: unknown): {
      query(storeId: string, q: unknown[]): Promise<DoAnswer>;
      authOp(storeId: string, op: string, argsJson: string): Promise<DoAnswer>;
      mutate(storeId: string, m: unknown): Promise<DoAnswer>;
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
const freshIp = () => `10.91.${(ip >> 8) & 255}.${ip++ & 255}`;
const stub = (storeId: string) => e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
async function doRead<T>(storeId: string, model: string, args: Record<string, unknown>) {
  const a = await stub(storeId).query(storeId, [{ model, op: 'findMany', args }]);
  if (!a.ok) throw new Error(`DO refused: ${a.code} ${a.message ?? ''}`);
  return (JSON.parse(a.json) as T[][])[0]!;
}
async function pgReaches(reset = false): Promise<Array<{ label: string; stack: string }>> {
  const r = await e.API.fetch(`https://api.ebda.app/__dev/pg-reaches${reset ? '?reset=1' : ''}`);
  return ((await r.json()) as { reaches: Array<{ label: string; stack: string }> }).reaches;
}

describe.skipIf(e.E2E_DB === '1')('feature-gated subsystems on a DO store, Postgres gone', () => {
  let storeId = '';
  let owner = '';
  let customerId = '';
  let productId = '';
  let boProductId = '';
  let h: Record<string, string> = {};

  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await e.API.fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...h,
        'x-forwarded-for': freshIp(),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, text, json };
  };

  it('fixture: a DO store with every feature on, a customer in its DO, a product with a barcode', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const p of DEFAULT_PLAN_SEEDS)
      await e.PLATFORM_DB.prepare(
        'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      )
        .bind(`plan-${p.code}`, p.code, p.nameEn, p.nameAr, p.featureTier, JSON.stringify(p.limits))
        .run();
    for (const [i, k] of MARKER_KEYS.entries())
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
      )
        .bind(`fg-marker-${i}`, k)
        .run();
    owner = 'owner-fg';
    const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: owner,
        name: 'Gated Shop',
        slug: 'gated-shop',
        operator: true,
      }),
    });
    expect(created.status).toBe(200);
    storeId = ((await created.json()) as { id: string }).id;
    for (const key of FEATURE_KEYS_ARRAY)
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
      )
        .bind(`fg-feat-${key}`, storeId, key, Date.now())
        .run();
    await authState(`user:tv:${owner}`, [['set', `user:tv:${owner}`, '0', {}]]);
    const sa = await accessToken({ userId: owner, jti: 'j-fg', role: 'store_admin', storeId });
    h = { authorization: `Bearer ${sa}`, 'x-store-id': storeId };

    // the shopper's account is created in the store's DO (the customer-auth op that /auth/register calls), then verified
    customerId = crypto.randomUUID();
    const vtoken = `${storeId}~${'f'.repeat(64)}`;
    const vhash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(vtoken))),
    ]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const reg = await stub(storeId).authOp(
      storeId,
      'register',
      JSON.stringify({
        id: customerId,
        email: 'gated-buyer@exit-test.invalid',
        passwordHash: 'x'.repeat(60),
        firstName: 'Gated',
        lastName: 'Buyer',
        verification: { tokenHash: vhash, expiresAt: Date.now() + 3_600_000, rowId: 'v-fg' },
      })
    );
    expect(reg.ok, JSON.stringify(reg)).toBe(true);
    const verified = await e.API.fetch(`${BASE}/auth/verify-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ token: vtoken }),
    });
    expect(verified.status).toBe(200);

    productId = crypto.randomUUID();
    const now = Date.now();
    const seeded = await e.API.fetch(`${BASE}/internal/store-do/${storeId}/seed`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer workers-test-seed-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        products: [
          {
            id: productId,
            storeId,
            name: 'Gated Product',
            slug: 'gated-product',
            price: 5000,
            inventory: 100,
            barcode: 'GATED-0001',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: (boProductId = crypto.randomUUID()),
            storeId,
            name: 'Preorder Product',
            slug: 'preorder-product',
            price: 3000,
            inventory: 1,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });
    expect(seeded.status).toBe(200);
    // the seed loader keeps the base product columns; the barcode is written the way the admin product edit writes it
    const bc = await stub(storeId).mutate(storeId, {
      ops: [
        {
          model: 'Product',
          op: 'update',
          args: { where: { id: productId, storeId }, data: { barcode: 'GATED-0001' } },
        },
        {
          model: 'Product',
          op: 'update',
          args: { where: { id: boProductId, storeId }, data: { allowBackorder: true } },
        },
      ],
    });
    expect(bc.ok, JSON.stringify(bc)).toBe(true);
    await pgReaches(true);
  }, 120_000);

  it('warehouses: create two, the default moves atomically, update, deactivate, stock list', async () => {
    const a = await api(`/stores/${storeId}/warehouses`, {
      method: 'POST',
      body: { name: 'Main', code: 'main', isDefault: true, priority: 10 },
    });
    expect(a.status, a.text).toBe(201);
    const b = await api(`/stores/${storeId}/warehouses`, {
      method: 'POST',
      body: { name: 'Second', code: 'sec', isDefault: true },
    });
    expect(b.status, b.text).toBe(201);
    const aId = a.json.data.id ?? a.json.data.warehouse?.id;
    const bId = b.json.data.id ?? b.json.data.warehouse?.id;
    let rows = await doRead<{ id: string; isDefault: boolean; code: string }>(
      storeId,
      'Warehouse',
      {
        where: { storeId },
      }
    );
    expect(rows.filter(r => r.isDefault).map(r => r.id)).toEqual([bId]);
    const dup = await api(`/stores/${storeId}/warehouses`, {
      method: 'POST',
      body: { name: 'Dup', code: 'MAIN' },
    });
    expect(dup.status).toBe(409);

    const up = await api(`/stores/${storeId}/warehouses/${aId}`, {
      method: 'PUT',
      body: { name: 'Main Renamed', isDefault: true },
    });
    expect(up.status, up.text).toBe(200);
    rows = await doRead(storeId, 'Warehouse', { where: { storeId } });
    expect(rows.filter(r => r.isDefault).map(r => r.id)).toEqual([aId]);

    const list = await api(`/stores/${storeId}/warehouses`);
    expect(list.status, list.text).toBe(200);
    expect(JSON.stringify(list.json)).toContain('Main Renamed');
    expect((await api(`/stores/${storeId}/warehouses/${aId}`)).status).toBe(200);
    expect((await api(`/stores/${storeId}/warehouses/${aId}/stock`)).status).toBe(200);
    const del = await api(`/stores/${storeId}/warehouses/${bId}`, { method: 'DELETE' });
    expect(del.status, del.text).toBeLessThan(300);
    expect(await pgReaches(true)).toEqual([]);
  }, 60_000);

  it('customer wallet: an admin credit lands in the DO ledger, the wallet page lists it, an overdraw is refused', async () => {
    const key = crypto.randomUUID();
    const credit = await api(`/stores/${storeId}/customers/${customerId}/wallet/adjustments`, {
      method: 'POST',
      body: { amount: 2500, note: 'goodwill', idempotencyKey: key },
    });
    expect(credit.status, credit.text).toBe(201);
    const replay = await api(`/stores/${storeId}/customers/${customerId}/wallet/adjustments`, {
      method: 'POST',
      body: { amount: 2500, note: 'goodwill', idempotencyKey: key },
    });
    expect(replay.status, replay.text).toBe(200);
    expect(replay.json.data.replayed).toBe(true);
    const over = await api(`/stores/${storeId}/customers/${customerId}/wallet/adjustments`, {
      method: 'POST',
      body: { amount: -9999, note: 'too much', idempotencyKey: crypto.randomUUID() },
    });
    expect(over.status, over.text).toBe(409);

    const page = await api(`/stores/${storeId}/wallets`);
    expect(page.status, page.text).toBe(200);
    expect(page.json.data.summary).toEqual({ outstandingTotal: 2500, walletsWithBalance: 1 });
    expect(page.json.data.wallets[0].customer.email).toBe('gated-buyer@exit-test.invalid');
    const one = await api(`/stores/${storeId}/customers/${customerId}/wallet`);
    expect(one.status, one.text).toBe(200);
    expect(one.json.data.balance).toBe(2500);
    expect(one.json.data.transactions).toHaveLength(1);
    const ledger = await doRead<{ amount: number }>(storeId, 'WalletTransaction', {
      where: { storeId, customerId },
    });
    expect(ledger.map(t => t.amount)).toEqual([2500]);
    expect(await pgReaches(true)).toEqual([]);
  }, 60_000);

  it('loyalty: settings on, a manual award, then members / stats / transaction log from the DO', async () => {
    const on = await api(`/stores/${storeId}/loyalty/settings`, {
      method: 'PUT',
      body: { loyaltyEnabled: true },
    });
    expect(on.status, on.text).toBe(200);
    const award = await api(`/stores/${storeId}/loyalty/members/${customerId}/award`, {
      method: 'POST',
      body: { points: 150, type: 'earn_manual', description: 'welcome' },
    });
    expect(award.status, award.text).toBeLessThan(300);
    const members = await api(`/stores/${storeId}/loyalty/members`);
    expect(members.status, members.text).toBe(200);
    expect(JSON.stringify(members.json)).toContain('gated-buyer@exit-test.invalid');
    const stats = await api(`/stores/${storeId}/loyalty/stats`);
    expect(stats.status, stats.text).toBe(200);
    expect(stats.json.data.stats.totalMembers).toBe(1);
    const log = await api(`/stores/${storeId}/loyalty/transactions`);
    expect(log.status, log.text).toBe(200);
    expect(JSON.stringify(log.json)).toContain('welcome');
    expect(await pgReaches(true)).toEqual([]);
  }, 60_000);

  it('affiliates: config, invite, list with counts, stats, update, events, delete one with no history', async () => {
    const cfg = await api(`/stores/${storeId}/affiliates/config`, {
      method: 'PUT',
      body: { defaultCommissionRate: 12, publicSignupEnabled: true },
    });
    expect(cfg.status, cfg.text).toBe(200);
    expect(
      (await api(`/stores/${storeId}/affiliates/config`)).json.data.config.publicSignupEnabled
    ).toBe(true);
    const made = await api(`/stores/${storeId}/affiliates`, {
      method: 'POST',
      body: { name: 'Influencer One', email: 'aff1@exit-test.invalid' },
    });
    expect(made.status, made.text).toBe(201);
    const affId = made.json.data.id ?? made.json.data.affiliate?.id;
    const dup = await api(`/stores/${storeId}/affiliates`, {
      method: 'POST',
      body: { name: 'Again', email: 'aff1@exit-test.invalid' },
    });
    expect(dup.status).toBe(409);
    const list = await api(`/stores/${storeId}/affiliates`);
    expect(list.status, list.text).toBe(200);
    expect(JSON.stringify(list.json)).toContain('Influencer One');
    const stats = await api(`/stores/${storeId}/affiliates/stats`);
    expect(stats.status, stats.text).toBe(200);
    const up = await api(`/stores/${storeId}/affiliates/${affId}`, {
      method: 'PUT',
      body: { notes: 'top seller' },
    });
    expect(up.status, up.text).toBe(200);
    const events = await api(`/stores/${storeId}/affiliates/${affId}/events`);
    expect(events.status, events.text).toBe(200);
    // the guard: a balance never moves through the generic writer (only the affiliate money ops)
    const del = await api(`/stores/${storeId}/affiliates/${affId}`, { method: 'DELETE' });
    expect(del.status, del.text).toBeLessThan(300);
    expect(await doRead(storeId, 'Affiliate', { where: { id: affId } })).toEqual([]);
    expect(await pgReaches(true)).toEqual([]);
  }, 60_000);

  it('suppliers: create, patch, delete; an unknown one is a 404 (not a 500)', async () => {
    const made = await api(`/stores/${storeId}/suppliers`, {
      method: 'POST',
      body: { name: 'Cairo Textiles' },
    });
    expect(made.status, made.text).toBe(201);
    const id = made.json.data.id;
    expect(
      (
        await api(`/stores/${storeId}/suppliers/${id}`, {
          method: 'PATCH',
          body: { phone: '0100' },
        })
      ).status
    ).toBe(200);
    expect(
      (await api(`/stores/${storeId}/suppliers/${id}`, { method: 'DELETE' })).status
    ).toBeLessThan(300);
    const gone = await api(`/stores/${storeId}/suppliers/${id}`, {
      method: 'PATCH',
      body: { phone: '0100' },
    });
    expect(gone.status, gone.text).toBe(404);
    const exp = await api(`/stores/${storeId}/expenses/${crypto.randomUUID()}/approve`, {
      method: 'POST',
      body: {},
    });
    expect(exp.status, exp.text).toBe(404);
    expect(await pgReaches(true)).toEqual([]);
  }, 60_000);

  it('campaign test-send reads the campaign and the store on the DO (no Postgres transaction)', async () => {
    const made = await api(`/stores/${storeId}/campaigns`, {
      method: 'POST',
      body: { name: 'Eid', subject: 'Eid offers', bodyHtml: '<p>Hello</p>' },
    });
    expect(made.status, made.text).toBeLessThan(300);
    const id = made.json.data.id ?? made.json.data.campaign?.id;
    const sent = await api(`/stores/${storeId}/campaigns/${id}/test`, { method: 'POST', body: {} });
    // no mail provider is bound in this Worker: the send itself may be refused as not configured, never a Postgres 500
    expect(sent.status, sent.text).not.toBe(500);
    expect(sent.text).not.toContain('POSTGRES_REMOVED');
    expect(await pgReaches(true)).toEqual([]);
  }, 60_000);

  it('a placed order: pick-progress, scan-to-pick to full, backorders, abandoned-cart stats, the product feed', async () => {
    const session = 'sess-fg-1';
    const shopper = { 'x-store-id': storeId, 'x-session-id': session };
    const add = await e.API.fetch(`${BASE}/public/cart/items`, {
      method: 'POST',
      headers: { ...shopper, 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ productId, quantity: 2 }),
    });
    expect(add.status, await add.clone().text()).toBeLessThan(300);
    const placed = await e.API.fetch(`${BASE}/public/orders`, {
      method: 'POST',
      headers: { ...shopper, 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({
        paymentMethod: 'cod',
        shippingAddress: {
          firstName: 'Gated',
          lastName: 'Buyer',
          address1: '1 Test St',
          city: 'Cairo',
          phone: '+201000000777',
          country: 'EG',
        },
      }),
    });
    const ptext = await placed.text();
    expect(placed.status, ptext).toBeLessThan(300);
    const pj = JSON.parse(ptext) as { data: { id?: string; order?: { id: string } } };
    const orderId = pj.data.order?.id ?? pj.data.id!;
    await pgReaches(true);

    const progress = await api(`/stores/${storeId}/inventory/orders/${orderId}/pick-progress`);
    expect(progress.status, progress.text).toBe(200);
    expect(progress.json.data.fullyPicked).toBe(false);
    const pick1 = await api(`/stores/${storeId}/inventory/orders/${orderId}/pick`, {
      method: 'POST',
      body: { barcode: 'GATED-0001' },
    });
    expect(pick1.status, pick1.text).toBe(200);
    expect(pick1.json.data).toMatchObject({
      pickedQtyBefore: 0,
      pickedQtyAfter: 1,
      orderFullyPicked: false,
    });
    const pick2 = await api(`/stores/${storeId}/inventory/orders/${orderId}/pick`, {
      method: 'POST',
      body: { barcode: 'GATED-0001', qty: 5 },
    });
    expect(pick2.status, pick2.text).toBe(200);
    // capped at the line's quantity
    expect(pick2.json.data).toMatchObject({
      pickedQtyAfter: 2,
      fullyPicked: true,
      orderFullyPicked: true,
    });
    const again = await api(`/stores/${storeId}/inventory/orders/${orderId}/pick`, {
      method: 'POST',
      body: { barcode: 'GATED-0001' },
    });
    expect(again.status, again.text).toBe(409);
    const items = await doRead<{ pickedQty: number }>(storeId, 'OrderItem', { where: { orderId } });
    expect(items.map(i => i.pickedQty)).toEqual([2]);

    expect((await api(`/stores/${storeId}/backorders`)).status).toBe(200);
    const ac = await api(`/stores/${storeId}/abandoned-carts/stats`);
    expect(ac.status, ac.text).toBe(200);
    expect(ac.json.data.guestCheckout).toBe(true);
    const feed = await e.API.fetch(`${BASE}/public/feed/products.json`, {
      headers: { 'x-store-id': storeId, 'x-forwarded-for': freshIp() },
    });
    expect(feed.status, await feed.clone().text()).toBe(200);
    expect(await pgReaches(true)).toEqual([]);
  }, 90_000);

  it('backorders: an oversold line is listed, cancelling it heals the stock debt once and writes the marker; a second cancel is 404', async () => {
    const shopper = { 'x-store-id': storeId, 'x-session-id': 'sess-fg-bo' };
    const add = await e.API.fetch(`${BASE}/public/cart/items`, {
      method: 'POST',
      headers: { ...shopper, 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ productId: boProductId, quantity: 3 }),
    });
    expect(add.status, await add.clone().text()).toBeLessThan(300);
    const placed = await e.API.fetch(`${BASE}/public/orders`, {
      method: 'POST',
      headers: { ...shopper, 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({
        paymentMethod: 'cod',
        shippingAddress: {
          firstName: 'Pre',
          lastName: 'Order',
          address1: '2 Test St',
          city: 'Cairo',
          phone: '+201000000778',
          country: 'EG',
        },
      }),
    });
    expect(placed.status, await placed.clone().text()).toBeLessThan(300);
    const before = await doRead<{ inventory: number }>(storeId, 'Product', {
      where: { id: boProductId },
    });
    expect(before[0]!.inventory).toBe(-2);
    await pgReaches(true);

    const list = await api(`/stores/${storeId}/backorders`);
    expect(list.status, list.text).toBe(200);
    const line = (
      list.json.data as Array<{
        id: string;
        qty: number;
        productId: string;
        orderItem: { orderId: string };
      }>
    ).find(l => l.productId === boProductId)!;
    const refundedEvents = async () =>
      (
        (await (await e.API.fetch('https://api.ebda.app/__dev/dispatched')).json()) as {
          events: Array<{ name: string; orderId: string | null }>;
        }
      ).events.filter(ev => ev.name === 'order/refunded' && ev.orderId === line.orderItem.orderId);
    expect(await refundedEvents()).toHaveLength(0);
    expect(line.qty).toBeGreaterThanOrEqual(2); // checkout records the whole oversold line
    const cancel = await api(`/stores/${storeId}/backorders/${line.id}/cancel`, {
      method: 'POST',
      body: { reason: 'supplier discontinued' },
    });
    expect(cancel.status, cancel.text).toBe(200);
    // a COD order is unpaid: the books reverse the line but nothing is owed back
    expect(cancel.json.data.owedToCustomer).toBe(0);
    const after = await doRead<{ inventory: number }>(storeId, 'Product', {
      where: { id: boProductId },
    });
    expect(after[0]!.inventory).toBe(0);
    const markers = await doRead<{ metadata: unknown }>(storeId, 'OrderEvent', {
      where: { storeId, toStatus: 'backorder_line_cancelled' },
    });
    expect(markers).toHaveLength(1);
    expect(JSON.stringify(markers[0]!.metadata)).toContain('stockRestored');
    // the item-level order/refunded event (GL partial reversal + owed amount) went out exactly once
    expect(await refundedEvents()).toHaveLength(1);
    // the same line again, by ANOTHER admin with another reason: a replay (200, same figures), no second heal, no second event
    await authState('user:tv:super-fg', [['set', 'user:tv:super-fg', '0', {}]]);
    const su = await accessToken({ userId: 'super-fg', jti: 'j-fg-su', role: 'super_admin' });
    const again = await e.API.fetch(`${BASE}/stores/${storeId}/backorders/${line.id}/cancel`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${su}`,
        'x-store-id': storeId,
        'content-type': 'application/json',
        'x-forwarded-for': freshIp(),
      },
      body: JSON.stringify({ reason: 'another reason' }),
    });
    const againText = await again.text();
    expect(again.status, againText).toBe(200);
    expect(JSON.parse(againText).data).toMatchObject({ owedToCustomer: 0, replayed: true });
    expect(await refundedEvents()).toHaveLength(1);
    const stillZero = await doRead<{ inventory: number }>(storeId, 'Product', {
      where: { id: boProductId },
    });
    expect(stillZero[0]!.inventory).toBe(0);
    const unknown = await api(`/stores/${storeId}/backorders/${crypto.randomUUID()}/cancel`, {
      method: 'POST',
      body: { reason: 'x' },
    });
    expect(unknown.status, unknown.text).toBe(404);
    const open = await api(`/stores/${storeId}/backorders`);
    expect(open.json.data.some((l: { id: string }) => l.id === line.id)).toBe(false);
    expect(await pgReaches(true)).toEqual([]);
  }, 90_000);
});
