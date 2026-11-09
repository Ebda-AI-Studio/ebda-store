/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * PERF-LATENCY call-count budgets (NEON-SCALE-1 "a test that counts calls"; launch map PERF-LATENCY, 2026-11-09).
 *
 * The built Worker on workerd, a store on D1 + its StoreDO. Each hot path is driven through the real API and the per-binding
 * call counts are read back from its `Server-Timing` (`d1;desc="<calls>"`, `store-do;...`, lib/io-tally.ts). On the deployed
 * Worker every remote call is a network round trip (D1 primary, the store's DO, the AuthState shard, the identity Worker), so a
 * count is the latency floor of the path: the budgets below fail CI when a change adds a serial hop.
 *
 * A budget is a ceiling, set at what the path needs after PERF-LATENCY (the "before" counts are in the PR body). Raise one only
 * with a Ruling that names the new call and why it cannot be batched.
 *
 * Run: npm run -w apps/api cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/latency-budget.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';

type Kind = 'd1' | 'store-do' | 'auth-state' | 'do-other' | 'accounts' | 'kv' | 'io-waves';
type Tally = Record<Kind, number>;

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
      authOp(
        storeId: string,
        op: string,
        argsJson: string
      ): Promise<{ ok: true; json: string } | { ok: false; code: string }>;
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
const EMAIL = 'budget-shopper@exit-test.invalid';
const PW = 'Passw0rd!xyz';
// bcrypt cost 4 of PW (test fixture only; production hashes are cost 12, see the PR's bcrypt note)
const HASH = '$2b$04$jYDlZaJj/X/kmBmzPXDwsOP4.aIZ2IBm.rDUDGyiC8iKKUZPb/Rzm';

let ip = 0;
const freshIp = () => `10.91.${(ip >> 8) & 255}.${ip++ & 255}`;
const api = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  e.API.fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'x-forwarded-for': freshIp(),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

/** The per-binding call counts of one response (0 for a kind it did not call). */
export function tallyOf(serverTiming: string | null): Tally {
  const t: Tally = {
    d1: 0,
    'store-do': 0,
    'auth-state': 0,
    'do-other': 0,
    accounts: 0,
    kv: 0,
    'io-waves': 0,
  };
  for (const part of (serverTiming ?? '').split(',')) {
    const m = /^\s*([a-z0-9-]+);desc="(\d+)"/.exec(part);
    if (m && m[1] in t) t[m[1] as Kind] = Number(m[2]);
  }
  return t;
}
const remote = (t: Tally) => t.d1 + t['store-do'] + t['auth-state'] + t['do-other'] + t.accounts;

const measured: Record<string, Tally> = {};
const ops: Record<string, string[]> = {};

/**
 * Ceilings per path, measured 2026-11-09 after PERF-LATENCY (before -> after, waves = serial round trips):
 *   store resolve 2 -> 2 · product list / pdp 5 -> 4 · cart get 2 -> 2 · cart add 16 -> 15 · order create 38 -> 37 ·
 *   customer sign-in 11 -> 8 · customer /auth/me 4 -> 3 · merchant order list 7 -> 4.
 * +1 call / +1 wave on store resolve, product list, PDP, cart add, order create (`rl:store-miss`) and on customer sign-in
 * (`rl:auth-ip-fail`): the launch rate limits of #473 (Ruling PERF-LAT-1 addendum), a deliberate security hop, not a regression.
 * `remote` = D1 + StoreDO + AuthState + other DO + identity calls (KV is edge-local and not counted).
 * The NEON-SCALE-1 targets (public reads 0 D1 / 0 DO; a cart or order write ONE batched DO call) are NOT met yet: the order and
 * cart paths still make 10 StoreDO calls each (see the PR's follow-ups). Lower a ceiling whenever a change lowers the count.
 */
const BUDGET: Record<string, { remote: number; waves: number }> = {
  'store resolve': { remote: 3, waves: 3 },
  'product list': { remote: 4, waves: 5 },
  pdp: { remote: 4, waves: 5 },
  'cart get': { remote: 2, waves: 2 },
  'cart add (guest)': { remote: 16, waves: 16 },
  'order create (guest, cod)': { remote: 31, waves: 38 },
  'customer sign-in': { remote: 13, waves: 9 },
  'customer /auth/me': { remote: 4, waves: 3 },
  'merchant order list': { remote: 6, waves: 4 },
};
async function measure(name: string, res: Response): Promise<{ tally: Tally; body: string }> {
  const body = await res.text();
  expect(res.status, `${name}: ${body.slice(0, 300)}`).toBeLessThan(300);
  const tally = tallyOf(res.headers.get('server-timing'));
  measured[name] = tally;
  ops[name] = decodeURIComponent(res.headers.get('x-dev-io-ops') ?? '').split('\n');
  return { tally, body };
}

describe.skipIf(e.E2E_DB === '1')('latency budgets: remote calls per hot request', () => {
  let storeId = '';
  let productId = '';
  let ownerTok = '';

  it('fixture: a DO store, a product, a verified shopper, an owner', async () => {
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
        .bind(`budget-marker-${i}`, k)
        .run();
    const owner = 'owner-budget';
    const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: owner,
        name: 'Budget Shop',
        slug: 'budget-shop',
        operator: true,
      }),
    });
    expect(created.status).toBe(200);
    storeId = ((await created.json()) as { id: string }).id;
    await authState(`user:tv:${owner}`, [['set', `user:tv:${owner}`, '0', {}]]);
    ownerTok = await accessToken({ userId: owner, jti: 'j-budget-owner', role: 'store_admin' });

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
            name: 'Budget Product',
            slug: 'budget-product',
            price: 5000,
            inventory: 1000,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });
    expect(seeded.status).toBe(200);

    const sha = async (t: string) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    const vtoken = `${storeId}~${'b'.repeat(64)}`;
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
    const reg = await stub.authOp(
      storeId,
      'register',
      JSON.stringify({
        id: 'budget-user',
        email: EMAIL,
        passwordHash: HASH,
        firstName: 'Bud',
        lastName: 'Get',
        verification: {
          tokenHash: await sha(vtoken),
          expiresAt: Date.now() + 3_600_000,
          rowId: 'v-budget',
        },
      })
    );
    expect(reg.ok, JSON.stringify(reg)).toBe(true);
    expect(
      (await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: vtoken }) }))
        .status
    ).toBe(200);
  }, 120_000);

  it('measures the hot paths (warm: each request is made once before it is counted)', async () => {
    const shopper = { 'x-store-id': storeId };
    // warm every isolate-level cache once (JWKS, platform client, directory), then count the second call
    const twice = async (name: string, call: () => Promise<Response>) => {
      await (await call()).text();
      return measure(name, await call());
    };
    await twice('store resolve', () => api('/public/stores/budget-shop'));
    await twice('product list', () => api('/public/products?limit=24', { headers: shopper }));
    await twice('pdp', () => api('/public/products/budget-product', { headers: shopper }));
    await twice('cart get', () =>
      api(`/stores/${storeId}/cart`, { headers: { 'x-session-id': 'sess-budget-get' } })
    );

    let n = 0;
    const cartAdd = () =>
      api('/public/cart/items', {
        method: 'POST',
        headers: { ...shopper, 'x-session-id': `sess-budget-${++n}` },
        body: JSON.stringify({ productId, quantity: 1 }),
      });
    await twice('cart add (guest)', cartAdd);

    const order = async () => {
      const add = await cartAdd();
      expect(add.status).toBeLessThan(300);
      return api('/public/orders', {
        method: 'POST',
        headers: { ...shopper, 'x-session-id': `sess-budget-${n}` },
        body: JSON.stringify({
          paymentMethod: 'cod',
          shippingAddress: {
            firstName: 'Budget',
            lastName: 'Order',
            address1: '1 Test St',
            city: 'Cairo',
            phone: `+2010${String(5_000_000 + n).padStart(8, '0')}`,
            country: 'EG',
          },
        }),
      });
    };
    await twice('order create (guest, cod)', order);

    const login = () =>
      api('/auth/login', {
        method: 'POST',
        headers: { 'x-session-id': `sess-login-${++n}` },
        body: JSON.stringify({ email: EMAIL, password: PW, storeId }),
      });
    const { body } = await twice('customer sign-in', login);
    const customerTok = (JSON.parse(body) as { data: { accessToken: string } }).data.accessToken;
    await twice('customer /auth/me', () =>
      api('/auth/me', { headers: { authorization: `Bearer ${customerTok}` } })
    );
    await twice('merchant order list', () =>
      api(`/stores/${storeId}/orders?limit=20`, {
        headers: { authorization: `Bearer ${ownerTok}` },
      })
    );

    const over = Object.entries(BUDGET).flatMap(([name, b]) => {
      const t = measured[name];
      if (!t) return [`${name}: not measured`];
      const r = remote(t);
      return [
        ...(r > b.remote ? [`${name}: ${r} remote calls > budget ${b.remote}`] : []),
        ...(t['io-waves'] > b.waves
          ? [`${name}: ${t['io-waves']} serial waves > budget ${b.waves}`]
          : []),
      ];
    });
    expect(over, `${over.join('\n')}\nops:\n${JSON.stringify(ops, null, 1)}`).toEqual([]);
  }, 120_000);
});
