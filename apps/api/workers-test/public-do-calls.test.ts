/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * PERF-RL-DO: Durable Object round trips of PUBLIC requests on workerd (the built Worker, a store on D1 + its StoreDO).
 *
 *  1. Rate limiting: a store resolve makes exactly ONE AuthState call for its limiters (per-IP, tenant-or-IP, store-miss
 *     co-located on the client's shard and prefetched in one batch), a tenant-scoped read at most two (client + tenant shard),
 *     issued together. Before: 3 calls / 2 serial waves (4 / 3 with a search term). Since LAUNCH-RL-MISS-1 the store-miss
 *     entry of that batch is a READ of its counter (`get` + `pttl`), not a hit; a 404 adds one call after the response.
 *  2. No request ever reaches the single global `cachegen` instance: the generic prefix generations are replicated per store
 *     shard and read with the store's own names (cf/auth-state-client.ts cachegenHome). Before: every cold fill read it 3x.
 *  3. The limits still bind per client: the store-miss limiter 429s one IP at miss 21 while another IP is unaffected.
 *
 * The instance of each call is read from the io tally's op label (`auth-state:@<instance>:apply:...`, DEV_STATS only).
 *   npm run cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/public-do-calls.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
  TEST_PLATFORM_MIGRATIONS: unknown[];
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

let n = 0;
const nextIp = () => `203.0.113.${(n++ % 250) + 1}`;
const call = (path: string, headers: Record<string, string> = {}, ip = nextIp()) =>
  e.API.fetch(`${BASE}${path}`, { headers: { 'cf-connecting-ip': ip, ...headers } });

interface Seen {
  status: number;
  /** AuthState calls: instance + first op. */
  calls: Array<{ instance: string; op: string }>;
}
async function observe(res: Response): Promise<Seen> {
  await res.text();
  const ops = decodeURIComponent(res.headers.get('x-dev-io-ops') ?? '')
    .split('\n')
    .filter(o => o.startsWith('auth-state:'));
  return {
    status: res.status,
    calls: ops.map(o => {
      const m = /^auth-state:@([^:]+):apply:(.*)$/.exec(o);
      return { instance: m?.[1] ?? '?', op: m?.[2] ?? o };
    }),
  };
}
const rlCalls = (s: Seen) => s.calls.filter(c => c.op.includes('"rl:'));
const cachegenCalls = (s: Seen) => s.calls.filter(c => c.op.includes('"cachegen:'));

/** The headers ebda-web adds to an API fetch (apps/web/ssr-client-address.ts): v1 address + v2 request-bound signature. */
async function signedRender(
  path: string,
  shopper: string,
  host: string,
  secret = 'workers-test-revalidate-secret',
  at = Date.now()
) {
  const enc = new TextEncoder();
  const hex = (b: ArrayBuffer) =>
    Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
  const k1 = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const v1 = hex(
    await crypto.subtle.sign('HMAC', k1, enc.encode(`ebda-ssr-client-ip.v1\n${shopper}`))
  );
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  const k2 = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: enc.encode('ebda-ssr-forward.v2'),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign']
  );
  const msg = `ebda-ssr-forward.v2\nGET\n/api/v1${path}\n${host.toLowerCase()}\n${shopper}\n${at}`;
  const v2 = `${at}.${hex(await crypto.subtle.sign('HMAC', k2, enc.encode(msg)))}`;
  return { 'x-ebda-client-ip': shopper, 'x-ebda-ssr-auth': v1, 'x-ebda-ssr-v2': v2 };
}

describe.skipIf(e.E2E_DB === '1')('public request Durable Object round trips (PERF-RL-DO)', () => {
  let storeId = '';

  it('fixture: a DO store with one product', async () => {
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
        .bind(`rl-do-marker-${i}`, k)
        .run();
    const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-rl-do',
        name: 'RL Shop',
        slug: 'rl-do-shop',
        operator: true,
      }),
    });
    expect(created.status).toBe(200);
    storeId = ((await created.json()) as { id: string }).id;
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
            id: crypto.randomUUID(),
            storeId,
            name: 'P',
            slug: 'rl-p1',
            price: 5000,
            inventory: 10,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });
    expect(seeded.status).toBe(200);
  }, 120_000);

  it('a store resolve makes ONE rate-limit call, cold and warm, on one client shard', async () => {
    for (const phase of ['cold', 'warm']) {
      const s = await observe(await call('/public/stores/rl-do-shop'));
      expect(s.status, phase).toBe(200);
      const rl = rlCalls(s);
      expect(rl, `${phase}: ${JSON.stringify(s.calls)}`).toHaveLength(1);
      expect(rl[0].instance).toMatch(/^shard-\d+$/);
      // the op label is truncated at 80 chars: the batch starts with the per-IP hit and holds more than one op
      expect(rl[0].op.startsWith('[["hit","rl:public:')).toBe(true);
      expect(rl[0].op).toContain('],["hit","rl:public-tenant:');
    }
  });

  it('tenant-scoped reads and search: at most two rate-limit calls (client shard + tenant shard)', async () => {
    const h = { 'x-store-id': storeId };
    for (const path of [
      '/public/products?limit=24',
      '/public/products/rl-p1',
      '/public/products?search=p',
      `/public/${storeId}/search/suggest?q=p`,
    ]) {
      const s = await observe(await call(path, h));
      expect(s.status, path).toBe(200);
      const rl = rlCalls(s);
      expect(rl.length, `${path}: ${JSON.stringify(s.calls)}`).toBeLessThanOrEqual(2);
    }
  });

  it('no request reaches the global cachegen instance; a cold fill reads its generations from ONE store shard', async () => {
    const h = { 'x-store-id': storeId };
    const all: Seen[] = [];
    for (const path of ['/public/products?limit=7', '/public/products/rl-p1', '/public/categories'])
      all.push(await observe(await call(path, h)));
    all.push(await observe(await call('/public/stores/nope-nope-404')));
    for (const s of all) {
      for (const c of cachegenCalls(s))
        expect(c.instance, JSON.stringify(s.calls)).toMatch(/^cachegen-s\d+$/);
    }
    // the product-list fill: before-read, after-read, after-write re-check: three calls, all on the store's own shard
    const list = cachegenCalls(all[0]);
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map(c => c.instance)).size).toBe(1);
  });

  it('the store-miss limit still binds per client: 429 at miss 21 for one IP, another IP unaffected', async () => {
    const a = '198.51.100.21';
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push((await call(`/public/stores/miss-${i}-x`, {}, a)).status);
    expect(statuses.slice(0, 20).every(s => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
    // a hit (200) is never counted against the miss budget, but a blocked client stays blocked for misses
    expect((await call('/public/stores/miss-99-x', {}, a)).status).toBe(429);
    expect((await call('/public/stores/miss-99-x', {}, '198.51.100.22')).status).toBe(404);
  });

  /**
   * DO-BUDGET-2 guard (2026-11-11 alert: 212k DO requests/day against a 33k/day line). The CAPS below are the contract: a PR that
   * adds a serial AuthState call to a public read fails here. Mutation check: add one `applyOn` to the limiter path and the
   * `toBeLessThanOrEqual` lines fail.
   *   resolve, storefront render (verified HMAC): <= 1 AuthState call (the store-miss peek), 0 rate-limit HITS
   *   products,  storefront render (verified HMAC): <= 1 AuthState call (the store-miss peek), 0 rate-limit HITS
   *   resolve from the internet: 4 limiter calls (per-IP+miss batch, tenant by host, tenant by store id, store-resolve); the trusted render 1
   */
  it('a storefront render (verified HMAC) spends no rate-limit hit: resolve and products make at most ONE rate-limit call (the store-miss peek)', async () => {
    for (const path of ['/public/store/resolve', '/public/products?limit=24']) {
      const ip = nextIp();
      const headers = {
        'x-store-id': storeId,
        'x-store-domain': 'rl-do-shop.ebda.app',
        ...(await signedRender(path, ip, 'rl-do-shop.ebda.app')),
      };
      const s = await observe(await call(path, headers, '2a06:98c0:3600::103'));
      expect(s.status, path).toBe(200);
      expect(rlCalls(s).length, `${path}: ${JSON.stringify(s.calls)}`).toBeLessThanOrEqual(1);
      expect(
        s.calls.filter(c => c.op.startsWith('[["hit",')),
        `${path}: no rate-limit hit`
      ).toHaveLength(0);
    }
  });

  it('the same calls from the internet are still limited: a typed marker or a wrong-secret signature buys nothing', async () => {
    const ip = nextIp();
    for (const headers of [
      { 'x-ebda-trusted-ssr': '1', 'x-store-domain': 'rl-do-shop.ebda.app' },
      {
        'x-store-domain': 'rl-do-shop.ebda.app',
        ...(await signedRender(
          '/public/store/resolve',
          ip,
          'rl-do-shop.ebda.app',
          'not-the-secret'
        )),
      },
    ]) {
      const s = await observe(await call('/public/store/resolve', headers, ip));
      expect(s.status).toBe(200);
      expect(rlCalls(s).length, JSON.stringify(s.calls)).toBeGreaterThanOrEqual(1);
      // 4 since #868: the tenant bucket is predicted by host before the store resolves, then taken by store id after it
      expect(rlCalls(s).length, JSON.stringify(s.calls)).toBeLessThanOrEqual(4);
    }
  });

  it('an unresolved host still 404s for a verified render (never defaults to a store)', async () => {
    const ip = nextIp();
    const headers = {
      'x-store-domain': 'no-such-shop-zzz.ebda.app',
      ...(await signedRender('/public/store/resolve', ip, 'no-such-shop-zzz.ebda.app')),
    };
    const res = await call('/public/store/resolve', headers, '2a06:98c0:3600::103');
    expect(res.status).toBe(404);
  });

  it('a replayed signature (>60 s old) is limited like any caller', async () => {
    const ip = nextIp();
    const headers = {
      'x-store-domain': 'rl-do-shop.ebda.app',
      ...(await signedRender(
        '/public/store/resolve',
        ip,
        'rl-do-shop.ebda.app',
        undefined,
        Date.now() - 61_000
      )),
    };
    const s = await observe(await call('/public/store/resolve', headers, '2a06:98c0:3600::103'));
    expect(s.status).toBe(200);
    expect(s.calls.filter(c => c.op.startsWith('[["hit",')).length).toBeGreaterThanOrEqual(1);
  });

  it('a hot shopper through SSR falls back to the exact limiters (scraper protection)', async () => {
    const ip = nextIp();
    let hits = 0;
    for (let i = 0; i < 70; i++) {
      const path = `/public/products?limit=${(i % 5) + 1}`;
      const headers = { 'x-store-id': storeId, ...(await signedRender(path, ip, '')) };
      const s = await observe(await call(path, headers, '2a06:98c0:3600::103'));
      hits += s.calls.filter(c => c.op.startsWith('[["hit",')).length;
    }
    expect(hits).toBeGreaterThan(0);
  }, 60_000);
});
