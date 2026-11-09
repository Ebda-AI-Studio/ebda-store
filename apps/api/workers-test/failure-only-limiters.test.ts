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
// bcrypt cost 4 of PW (test fixture only)
const HASH = '$2b$04$jYDlZaJj/X/kmBmzPXDwsOP4.aIZ2IBm.rDUDGyiC8iKKUZPb/Rzm';
const MISS_MAX = 20;

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

  it('fixture: a DO store with one product and a verified shopper', async () => {
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
            slug: 'rl-miss-p1',
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
