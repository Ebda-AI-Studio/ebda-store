/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * LAUNCH-RL-MISS (Ruling LAUNCH-RL-MISS-1): the limiters that count FAILURES only, on workerd (the built Worker, counters on
 * the real AuthState Durable Object, a store on D1 + its StoreDO).
 *
 * Production 2026-11-09: seven sequential 200s on a public storefront route moved the store-miss budget (20 misses / min per
 * IP) from 19 to 14, and the pre-QA sweep saw add-to-cart answered 429. The limiter counted every request up front and gave
 * the hit back after the response (express-rate-limit `skipSuccessfulRequests`).
 *
 *  1. store-miss: a request that is not a 404 never moves the miss budget: 25 sequential and 30 parallel successes from one
 *     IP are all served, the counter stays empty, `ratelimit-remaining` stays 20.
 *  2. store-miss still binds: 20 misses are answered 404 with the budget falling, miss 21 is 429 (RATE_LIMITED, Retry-After),
 *     the counter holds exactly 20, another IP is unaffected.
 *  2b. normal browsing of a real store is not a miss: an unedited policy page (200, `page: null`) and a slug with no
 *     redirect (200, `toSlug: null`) leave the counter at 0; the same page on an unknown store id is a counted 404.
 *  2c. LAUNCH-RL-MISS-3: a dead product or blog link inside a store the resolver verified is not a miss. 25 dead product
 *     links on the real store from one IP are all 404 with the counter at 0; a blog post 404 is uncounted only when the
 *     verified store is the path store. The product 404 says nothing: a draft, another store's product and one that never
 *     existed answer the same bytes (the blog twin of that pin is tests/unit/blog-post-miss-body.test.ts: the fixture
 *     store has no blog).
 *  2d. the walk: every public row of `route-table.json` is called on a store id that does not exist (every 404 is counted)
 *     and on the real store (a 404 is uncounted only on the two routes of `CATALOGUE_MISS_ROUTES`; nothing that is not a
 *     404 is ever written). Every public route must be classified below, so a new one fails the walk until it is.
 *  3. the IP-wide sign-in limiter (`rl:auth-ip-fail`, give-back kind): successful sign-ins leave its counter at 0, failed ones
 *     are counted.
 *
 * What this layer cannot show: local workerd lets a call started after the response run to completion, so the DROPPED
 * give-back seen in production does not reproduce here (measured: 25 of 25 landed). On the old code (1) fails on the header
 * and on the parallel half; the dropped give-back itself is pinned in tests/unit/public-limit-prefetch.test.ts (the give-back
 * is handed to `waitUntil`).
 *   npm run cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/failure-only-limiters.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { authState } from './helpers';
import { CATALOGUE_MISS_ROUTES } from '../src/middleware/catalogue-miss';
import ALL_ROUTES from './route-table.json';
import { TEST_PASSWORD_HASH } from './fixtures/test-password-hash';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
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
const EMAIL = 'nat-shopper@exit-test.invalid';
const PW = 'Passw0rd!xyz';
const HASH = TEST_PASSWORD_HASH;
const MISS_MAX = 20;
// fixture products: one live and one DRAFT in the store, one live in ANOTHER store
const P_LIVE = 'a1a1a1a1-0000-4000-8000-000000000001';
const P_DRAFT = 'a1a1a1a1-0000-4000-8000-000000000002';
const P_OTHER = 'b2b2b2b2-0000-4000-8000-000000000001';
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000dead';

/** Every route the public limiters sit in front of, from the generated route table. */
const PUBLIC_ROUTES = (ALL_ROUTES as string[]).filter(r => /^[A-Z]+ \/public(\/|$)/.test(r));
/**
 * LAUNCH-RL-MISS-3: the public routes whose 404 is a counted miss on ANY store, verified or not. With the two routes of
 * `CATALOGUE_MISS_ROUTES` this must be the whole public route table: a new public route is counted by the limiter with no
 * change, and it is added HERE (counted) unless a ruling puts it on the catalogue-miss list.
 */
const COUNTED_ON_ANY_STORE = [
  'DELETE /public/cart',
  'DELETE /public/cart/bundles/:cartBundleId',
  'DELETE /public/cart/items/:itemId',
  'GET /public/:storeId/affiliates/track',
  'GET /public/:storeId/blog',
  'GET /public/:storeId/cart/recommendations',
  'GET /public/:storeId/locations',
  'GET /public/:storeId/loyalty/info',
  'GET /public/:storeId/loyalty/my-points',
  'GET /public/:storeId/loyalty/my-transactions',
  'GET /public/:storeId/pages/:slug',
  'GET /public/:storeId/products/:productId/recommendations',
  'GET /public/:storeId/search/suggest',
  'GET /public/:storeId/wishlist/:userId',
  'GET /public/campaigns/unsubscribe',
  'GET /public/cart',
  'GET /public/cart/whatsapp-optin',
  'GET /public/categories',
  'GET /public/customers/me/reorder',
  'GET /public/feed/google.xml',
  'GET /public/feed/meta.xml',
  'GET /public/feed/products.json',
  'GET /public/feed/tiktok.csv',
  'GET /public/health',
  'GET /public/lifecycle-emails/unsubscribe',
  // LAUNCH-RL-MISS-3: a token-guarded guest read (signed order link, own orderStatusLimiter). Its 404 answers a bad or expired token, i.e. a guess,
  // so it is a COUNTED miss on any store; it is NOT a catalogue-miss route (that list is for public slugs whose 404 says nothing new).
  'GET /public/order-status/:token',
  'GET /public/orders',
  'GET /public/orders/:id',
  'GET /public/orders/:id/invoice',
  'GET /public/products',
  'GET /public/qr/scan',
  'GET /public/redirects/resolve',
  'GET /public/reviews/can-submit',
  'GET /public/size-charts',
  'GET /public/sms-consent/unsubscribe',
  'GET /public/store/resolve',
  'GET /public/stores',
  'GET /public/stores/:slugOrId',
  'GET /public/stores/:storeId/builder-preview',
  'GET /public/stores/:storeId/layout',
  'GET /public/stores/:storeId/pages/:kind',
  'GET /public/stores/:storeId/testimonials',
  'GET /public/tags',
  'GET /public/wholesale/products',
  'GET /public/wholesale/products/:slug',
  'GET /public/wholesale/status',
  'POST /public/:storeId/affiliates/apply',
  'POST /public/:storeId/loyalty/join',
  'POST /public/:storeId/push/subscribe',
  'POST /public/:storeId/push/unsubscribe',
  'POST /public/:storeId/views',
  'POST /public/campaigns/unsubscribe',
  'POST /public/cart/acknowledge-prices',
  'POST /public/cart/bundles',
  'POST /public/cart/email-optin',
  'POST /public/cart/from-wa',
  'POST /public/cart/items',
  'POST /public/cart/restore',
  'POST /public/cart/sync',
  'POST /public/cart/whatsapp-optin',
  'POST /public/contact',
  'POST /public/contact/enquiry',
  'POST /public/lifecycle-emails/unsubscribe',
  'POST /public/newsletter/subscribe',
  'POST /public/orders',
  'POST /public/orders/:id/verify-payment',
  'POST /public/orders/quote',
  'POST /public/pricing/resolve',
  'POST /public/returns/guest',
  'POST /public/reviews/submit',
  'POST /public/sms-consent/unsubscribe',
  'POST /public/wholesale/apply',
  'PUT /public/cart/items/:itemId',
];

const call = (
  path: string,
  ip: string,
  init: RequestInit & { headers?: Record<string, string> } = {}
) =>
  e.API.fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'cf-connecting-ip': ip,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
/** The counter as the Durable Object holds it (0 when the key does not exist). */
const counter = async (key: string) => Number((await authState(key, [['get', key]]))[0] ?? 0);
/** Work handed to `waitUntil` lands after the response: wait for the counter to reach `want`. */
async function settled(key: string, want: number): Promise<number> {
  let got = await counter(key);
  for (let i = 0; i < 40 && got !== want; i++) {
    await new Promise(r => setTimeout(r, 50));
    got = await counter(key);
  }
  return got;
}

describe.skipIf(e.E2E_DB === '1')('failures-only limiters on workerd (LAUNCH-RL-MISS)', () => {
  let storeId = '';
  let otherStoreId = '';

  it('fixture: a DO store with a live and a draft product, a second store, and a verified shopper', async () => {
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
        .bind(`rl-miss-marker-${i}`, k)
        .run();
    const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-rl-miss',
        name: 'NAT Shop',
        slug: 'rl-miss-shop',
        operator: true,
      }),
    });
    expect(created.status).toBe(200);
    storeId = ((await created.json()) as { id: string }).id;
    const createdOther = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-rl-miss-b',
        name: 'Other Shop',
        slug: 'rl-miss-other',
        operator: true,
      }),
    });
    expect(createdOther.status).toBe(200);
    otherStoreId = ((await createdOther.json()) as { id: string }).id;
    const now = Date.now();
    const seed = (store: string, products: Array<{ id: string; slug: string; status: string }>) =>
      e.API.fetch(`${BASE}/internal/store-do/${store}/seed`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer workers-test-seed-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          products: products.map(p => ({
            ...p,
            storeId: store,
            name: 'P',
            price: 5000,
            inventory: 10,
            createdAt: now,
            updatedAt: now,
          })),
        }),
      });
    const seeded = await seed(storeId, [
      { id: P_LIVE, slug: 'rl-miss-p1', status: 'active' },
      { id: P_DRAFT, slug: 'rl-miss-draft', status: 'draft' },
    ]);
    expect(seeded.status).toBe(200);
    const seededOther = await seed(otherStoreId, [
      { id: P_OTHER, slug: 'rl-miss-b1', status: 'active' },
    ]);
    expect(seededOther.status).toBe(200);

    const sha = async (t: string) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    const vtoken = `${storeId}~${'c'.repeat(64)}`;
    const reg = await e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).authOp(
      storeId,
      'register',
      JSON.stringify({
        id: 'nat-user',
        email: EMAIL,
        passwordHash: HASH,
        firstName: 'Nat',
        lastName: 'Shopper',
        verification: {
          tokenHash: await sha(vtoken),
          expiresAt: Date.now() + 3_600_000,
          rowId: 'v-nat',
        },
      })
    );
    expect(reg.ok, JSON.stringify(reg)).toBe(true);
    const verified = await call('/auth/verify-email', '192.0.2.200', {
      method: 'POST',
      body: JSON.stringify({ token: vtoken }),
    });
    expect(verified.status).toBe(200);
  }, 120_000);

  it('store-miss: 25 sequential successful public requests from one IP never move the miss budget', async () => {
    const ip = '192.0.2.10';
    const key = `rl:store-miss:${ip}`;
    const paths = ['/public/stores/rl-miss-shop', '/public/products?limit=24', '/public/health'];
    const seen: string[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await call(paths[i % paths.length], ip, { headers: { 'x-store-id': storeId } });
      await res.text();
      seen.push(
        `${res.status}:${res.headers.get('ratelimit-policy')}:${res.headers.get('ratelimit-remaining')}:${await counter(key)}`
      );
    }
    // status : the miss policy : misses left : the counter on the Durable Object right after the response
    expect(seen).toEqual(Array.from({ length: 25 }, () => `200:${MISS_MAX};w=60:${MISS_MAX}:0`));
    expect(await settled(key, 0)).toBe(0);
  });

  it('store-miss: 30 parallel successes from one IP (one carrier NAT) are all served', async () => {
    const ip = '192.0.2.11';
    const statuses = await Promise.all(
      Array.from({ length: 30 }, async () => {
        const res = await call('/public/stores/rl-miss-shop', ip);
        await res.text();
        return res.status;
      })
    );
    expect(statuses).toEqual(Array.from({ length: 30 }, () => 200));
    expect(await settled(`rl:store-miss:${ip}`, 0)).toBe(0);
  });

  it('store-miss still binds: 20 misses counted, miss 21 is 429, hits in between are free, another IP unaffected', async () => {
    const ip = '192.0.2.12';
    const key = `rl:store-miss:${ip}`;
    const seen: string[] = [];
    for (let i = 0; i < MISS_MAX; i++) {
      const res = await call(`/public/stores/no-such-store-${i}`, ip);
      await res.text();
      seen.push(`${res.status}:${res.headers.get('ratelimit-remaining')}`);
      // a hit between two misses is never counted
      if (i === 5) expect((await call('/public/stores/rl-miss-shop', ip)).status).toBe(200);
      expect(await settled(key, i + 1), `after miss ${i + 1}`).toBe(i + 1);
    }
    // misses left BEFORE each response: 20, 19, ... 1
    expect(seen).toEqual(Array.from({ length: MISS_MAX }, (_, i) => `404:${MISS_MAX - i}`));

    const blocked = await call('/public/stores/no-such-store-21', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('ratelimit-remaining')).toBe('0');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await blocked.json()) as {
      error: { code: string; details?: { messageAr?: string } };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details?.messageAr).toBeTruthy();
    // a 429 is not a miss: the counter stops at the limit
    expect(await settled(key, MISS_MAX)).toBe(MISS_MAX);
    expect((await call('/public/stores/no-such-store-21', '192.0.2.13')).status).toBe(404);
  });

  // Pre-QA sweep 2026-11-09, finding 6: ordinary browsing of a REAL store answered 404s that were counted as probing. A
  // policy page the merchant never edited (the storefront then shows its built-in copy) and a slug that was never renamed
  // are answers about a store that exists: 200, never counted. The same page on a store id that does not exist is still
  // a counted 404.
  it('store-miss: an unedited policy page and a slug with no redirect on a real store are 200 and not counted; an unknown store still is', async () => {
    const ip = '192.0.2.15';
    const key = `rl:store-miss:${ip}`;
    for (const slug of ['privacy', 'terms', 'about']) {
      const res = await call(`/public/${storeId}/pages/${slug}`, ip);
      expect(res.status, slug).toBe(200);
      expect(await res.json(), slug).toEqual({ success: true, data: { page: null } });
      expect(res.headers.get('ratelimit-remaining'), slug).toBe(String(MISS_MAX));
    }
    const noRedirect = await call('/public/redirects/resolve?type=product&slug=never-renamed', ip, {
      headers: { 'x-store-id': storeId },
    });
    expect(noRedirect.status).toBe(200);
    expect(await noRedirect.json()).toEqual({ toSlug: null });
    expect(noRedirect.headers.get('ratelimit-remaining')).toBe(String(MISS_MAX));
    await new Promise(r => setTimeout(r, 300));
    expect(await counter(key)).toBe(0);

    const unknown = await call(`/public/${crypto.randomUUID()}/pages/privacy`, ip);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'STORE_NOT_FOUND'
    );
    // exactly one: the miss above, and none of the four 200s before it
    expect(await settled(key, 1)).toBe(1);
    const after = await call(`/public/${storeId}/pages/privacy`, ip);
    expect(after.status).toBe(200);
    expect(after.headers.get('ratelimit-remaining')).toBe(String(MISS_MAX - 1));

    // a redirect lookup for a store that does not resolve is refused as before (400, so not a miss)
    const unresolved = await call('/public/redirects/resolve?type=product&slug=x', ip, {
      headers: { 'x-store-id': crypto.randomUUID() },
    });
    expect(unresolved.status).toBe(400);
    expect(((await unresolved.json()) as { error: { code: string } }).error.code).toBe(
      'STORE_NOT_RESOLVED'
    );
  });

  // LAUNCH-RL-MISS-3: a dead product link on a store that exists is not store probing. Before it, 20 of these from one IP
  // (a shopper behind a carrier NAT, or the storefront's own server render) got the whole public router refused.
  it('store-miss: 25 dead product links on a real store from one IP are all 404, never counted, never refused', async () => {
    const ip = '192.0.2.20';
    const key = `rl:store-miss:${ip}`;
    const seen: string[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await call(`/public/products/dead-link-${i}`, ip, {
        headers: { 'x-store-id': storeId },
      });
      await res.text();
      seen.push(`${res.status}:${res.headers.get('ratelimit-remaining')}`);
    }
    expect(seen).toEqual(Array.from({ length: 25 }, () => `404:${MISS_MAX}`));
    await new Promise(r => setTimeout(r, 500));
    expect(await counter(key)).toBe(0);
    // the same caller, the same route, no verified store: the route never answers a 404 at all (the store is refused first)
    for (const headers of [{ 'x-store-id': crypto.randomUUID() }, {}] as Record<string, string>[]) {
      const res = await call('/public/products/dead-link-0', ip, { headers });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'STORE_NOT_RESOLVED'
      );
    }
    // and this IP's budget is live: a store slug that does not exist is the first counted miss
    expect((await call('/public/stores/no-such-store-x', ip)).status).toBe(404);
    expect(await settled(key, 1)).toBe(1);
  });

  it('product by slug or id: a draft, another store’s product and one that never existed answer the same 404, byte for byte', async () => {
    const ip = '192.0.2.21';
    const get = async (ref: string, store = storeId) => {
      const res = await call(`/public/products/${ref}`, ip, { headers: { 'x-store-id': store } });
      return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
    };
    // controls: each product is real and served to its own store, by slug and by id
    expect((await get('rl-miss-p1')).status).toBe(200);
    expect((await get(P_LIVE)).status).toBe(200);
    expect((await get('rl-miss-b1', otherStoreId)).status).toBe(200);
    expect((await get(P_OTHER, otherStoreId)).status).toBe(200);

    const never = await get('never-existed');
    expect(never.status).toBe(404);
    expect(JSON.parse(never.body)).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    for (const ref of ['rl-miss-draft', P_DRAFT, 'rl-miss-b1', P_OTHER, NO_SUCH_ID])
      expect(await get(ref), ref).toEqual(never);
    // six dead links inside a verified store: none is a miss
    await new Promise(r => setTimeout(r, 500));
    expect(await counter(`rl:store-miss:${ip}`)).toBe(0);
  });

  it('blog post: a 404 is uncounted only when the verified store is the path store', async () => {
    const ip = '192.0.2.22';
    const key = `rl:store-miss:${ip}`;
    const dead = async (pathStore: string, headers: Record<string, string>) => {
      const res = await call(`/public/${pathStore}/blog/dead-post`, ip, { headers });
      await res.text();
      return res.status;
    };
    expect(await dead(storeId, { 'x-store-id': storeId })).toBe(404);
    await new Promise(r => setTimeout(r, 500));
    expect(await counter(key)).toBe(0);
    // verified one store, asked about another (a real one): counted
    expect(await dead(otherStoreId, { 'x-store-id': storeId })).toBe(404);
    expect(await settled(key, 1)).toBe(1);
    // a well-formed id of a real store in the path is not proof: counted
    expect(await dead(storeId, {})).toBe(404);
    expect(await settled(key, 2)).toBe(2);
  });

  describe('the public route table, walked (LAUNCH-RL-MISS-3)', () => {
    const fill = (route: string, store: string) =>
      route
        .replace(/^[A-Z]+ /, '')
        .replace(/:storeId/g, store)
        .replace(/:(slug|slugOrId|kind)\b/g, 'dead-link')
        .replace(/:[A-Za-z]+/g, NO_SUCH_ID);
    /** One request per public route, each from its own IP, then the miss counter of each IP. */
    async function walk(store: string, net: string) {
      const rows: Array<{ route: string; key: string; status: number; counted: number }> = [];
      for (const [i, route] of [...PUBLIC_ROUTES, 'GET /public/no-such-route'].entries()) {
        const method = route.split(' ')[0];
        const ip = `${net}.${i + 1}`;
        const res = await call(fill(route, store), ip, {
          method,
          headers: { 'x-store-id': store },
          ...(method === 'GET' ? {} : { body: '{}' }),
          signal: AbortSignal.timeout(20_000),
        });
        await res.text();
        rows.push({ route, key: `rl:store-miss:${ip}`, status: res.status, counted: 0 });
      }
      // the count is written after the response: give a wrong write time to land, and wait for each expected one
      await new Promise(r => setTimeout(r, 500));
      for (const row of rows)
        row.counted = row.status === 404 ? await settled(row.key, 1) : await counter(row.key);
      return rows;
    }
    const table = (rows: Array<{ route: string; status: number; counted: number }>) =>
      rows.map(r => `${r.status} counted=${r.counted} ${r.route}`).join('\n');

    it('every public route is classified: counted on any store, or on the catalogue-miss list', () => {
      expect(PUBLIC_ROUTES.length).toBeGreaterThan(60);
      expect([...COUNTED_ON_ANY_STORE, ...CATALOGUE_MISS_ROUTES].sort()).toEqual(
        [...PUBLIC_ROUTES].sort()
      );
    });

    it('a store id that does not exist: every 404 of every public route is a counted miss', async () => {
      const rows = await walk(crypto.randomUUID(), '198.51.100');
      for (const r of rows) {
        expect(r.status, r.route).not.toBe(429);
        expect(r.counted, `${r.status} ${r.route}\n${table(rows)}`).toBe(r.status === 404 ? 1 : 0);
      }
      const missed = rows.filter(r => r.status === 404).map(r => r.route);
      // not vacuous: the two catalogue routes and an unmatched path are among the counted 404s
      expect(missed).toEqual(
        expect.arrayContaining(['GET /public/:storeId/blog/:slug', 'GET /public/no-such-route'])
      );
      expect(missed.length).toBeGreaterThan(20);
    }, 180_000);

    it('the real store: a 404 is uncounted only on the catalogue-miss routes, and nothing else is ever written', async () => {
      const rows = await walk(storeId, '203.0.113');
      const exempt = new Set<string>(CATALOGUE_MISS_ROUTES);
      for (const r of rows) {
        expect(r.status, r.route).not.toBe(429);
        const want = r.status === 404 && !exempt.has(r.route) ? 1 : 0;
        expect(r.counted, `${r.status} ${r.route}\n${table(rows)}`).toBe(want);
      }
      // not vacuous: both catalogue routes answered 404 (uncounted above), and in-store 404s elsewhere were counted
      for (const route of CATALOGUE_MISS_ROUTES)
        expect(rows.find(r => r.route === route)?.status, route).toBe(404);
      const countedHere = rows.filter(r => r.counted === 1).map(r => r.route);
      expect(countedHere).toEqual(
        expect.arrayContaining([
          'GET /public/no-such-route',
          'GET /public/stores/:slugOrId', // a store slug that does not exist, asked with a real store's header
          'GET /public/orders/:id', // an order id that does not exist: never a free guess
          'GET /public/:storeId/locations',
        ])
      );
    }, 180_000);
  });

  it('sign-in: successful sign-ins from one IP leave the IP-wide failure budget untouched, failed ones are counted', async () => {
    const ip = '192.0.2.14';
    const key = `rl:auth-ip-fail:${ip}`;
    const login = (body: Record<string, string>, n: number) =>
      call('/auth/login', ip, {
        method: 'POST',
        headers: { 'x-session-id': `sess-nat-${n}` },
        body: JSON.stringify({ storeId, ...body }),
      });
    for (let i = 0; i < 8; i++) {
      const res = await login({ email: EMAIL, password: PW }, i);
      expect(res.status, await res.text()).toBe(200);
    }
    // every success was counted up front and given back after its response
    expect(await settled(key, 0)).toBe(0);

    for (let i = 0; i < 3; i++) {
      const res = await login(
        { email: `nobody-${i}@exit-test.invalid`, password: 'wrong-pass-1!' },
        100 + i
      );
      await res.text();
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(429);
    }
    await new Promise(r => setTimeout(r, 300));
    expect(await counter(key)).toBe(3);
  });
});
