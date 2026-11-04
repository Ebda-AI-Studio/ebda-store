/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * N-15 (NEON-ZERO-1): ROUTE SWEEP. The built Worker with Postgres at a dead port and every cutover marker set in D1
 * (billing, access, platform, inbox, ai-usage, analytics, customer-auth): walk the REAL router table
 * (`route-table.json`, generated from `@api/routes` by tests/unit/route-table-manifest.test.ts) and hit every route against a
 * store created on D1 + its Durable Object (N-18), as the roles that reach it. A route that answers 5xx (or hangs) is a
 * Postgres dependency the cutover has not removed. Each result is printed as one `SWEEP_RESULT {json}` line (the Worker's own
 * log lines carry the stack, joined on `requestId`); docs/cf/neon-zero-remaining.md is built from them.
 *
 *   EBDA_WORKERS_TEST_DB_URL=postgresql://u:p@127.0.0.1:1/x npx vitest run --config vitest.workers.config.mts workers-test/route-sweep.test.ts
 *
 * SWEEP_STRICT=1 turns "any failing route" into a red test; without it the sweep reports and passes (it is a measuring tool
 * until docs/cf/neon-zero-remaining.md is empty).
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';
import ALL_ROUTES from './route-table.json';

/** SWEEP_ONLY="re1,re2": keep only the routes (`METHOD /path`) matching any regex; unset = the whole table. */
const ONLY = ((env as unknown as { SWEEP_ONLY?: string }).SWEEP_ONLY ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => new RegExp(s));
const ROUTES: string[] = (ALL_ROUTES as string[]).filter(
  r => ONLY.length === 0 || ONLY.some(re => re.test(r))
);

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
};

const BASE = 'https://api.ebda.app/api/v1';
const ZERO = '00000000-0000-4000-8000-000000000001';
const MARKER_KEYS = [
  'platform_cutover.billing',
  'platform_cutover.access',
  'platform_cutover.platform',
  'platform_cutover.inbox',
  'platform_cutover.ai-usage',
  'platform_cutover.analytics',
  'customer_auth_cutover.__all',
];

interface Result {
  group: string;
  method: string;
  route: string;
  url: string;
  status: number;
  ms: number;
  code?: string;
  message?: string;
  requestId?: string;
}
const results: Result[] = [];
// Every request a different client address: the sweep measures Postgres dependencies, not the rate limiter.
let nextIp = 0;
const freshIp = (): string => `10.${(nextIp >> 16) & 255}.${(nextIp >> 8) & 255}.${nextIp++ & 255}`;

/** 2xx, or a 4xx that says "that thing is not there / your input is wrong" (what a sweep with empty fixtures should get). */
const EXPECTED_4XX = new Set([400, 401, 402, 403, 404, 405, 409, 410, 413, 415, 422, 423, 429]);

async function hit(
  group: string,
  method: string,
  route: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<Response | undefined> {
  const t0 = Date.now();
  const r: Result = { group, method, route, url, status: 0, ms: 0 };
  let res: Response | undefined;
  try {
    res = await e.API.fetch(url, {
      method,
      headers: {
        'x-forwarded-for': freshIp(),
        ...headers,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    r.status = res.status;
    r.requestId = res.headers.get('x-request-id') ?? undefined;
    if (res.status >= 400) {
      const text = await res.clone().text();
      try {
        const j = JSON.parse(text) as {
          error?: { code?: string; message?: string; requestId?: string };
        };
        r.code = j.error?.code;
        r.message = j.error?.message?.slice(0, 200);
        r.requestId ??= j.error?.requestId;
      } catch {
        r.message = text.slice(0, 200);
      }
    }
  } catch (err) {
    r.status = -1;
    r.message = String(err).slice(0, 200);
  }
  r.ms = Date.now() - t0;
  results.push(r);
  // eslint-disable-next-line no-console
  console.log('SWEEP_RESULT ' + JSON.stringify(r));
  return res;
}

const failing = (r: Result) => r.status < 0 || r.status >= 500;

/** Run `fns` with a bounded number in flight. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]!);
    })
  );
}

describe.skipIf(e.E2E_DB === '1')(
  'route sweep, Postgres unreachable, all cutover markers set',
  () => {
    let storeId = '';
    let owner = '';
    let sa = '';
    let su = '';
    let cust = '';

    it('fixture: a store created on D1 + its DO, markers set, tokens minted', async () => {
      await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
      for (const p of DEFAULT_PLAN_SEEDS)
        await e.PLATFORM_DB.prepare(
          'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
        )
          .bind(
            `plan-${p.code}`,
            p.code,
            p.nameEn,
            p.nameAr,
            p.featureTier,
            JSON.stringify(p.limits)
          )
          .run();
      for (const [i, k] of MARKER_KEYS.entries())
        await e.PLATFORM_DB.prepare(
          'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
        )
          .bind(`sweep-marker-${i}`, k)
          .run();
      owner = 'owner-sweep';
      const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
        method: 'POST',
        body: JSON.stringify({
          ownerId: owner,
          name: 'Sweep Shop',
          slug: 'sweep-shop',
          operator: true,
        }),
      });
      expect(created.status).toBe(200);
      storeId = ((await created.json()) as { id: string }).id;
      for (const u of [owner, 'super-sweep', 'cust-sweep'])
        await authState(`user:tv:${u}`, [['set', `user:tv:${u}`, '0', {}]]);
      sa = await accessToken({ userId: owner, jti: 'j-owner', role: 'store_admin', storeId });
      su = await accessToken({ userId: 'super-sweep', jti: 'j-super', role: 'super_admin' });
      cust = await accessToken({ userId: 'cust-sweep', jti: 'j-cust', role: 'customer', storeId });
    });

    const fill = (route: string): string =>
      route
        .replace(/:storeId/g, storeId)
        .replace(/:(storeSlug|slug)\b/g, 'sweep-shop')
        .replace(/:(token|key|code|provider)\b(\(\*\))?/g, 'sweep')
        .replace(/:[A-Za-z]+(\(\*\))?\??/g, ZERO)
        .replace(/\/$/, '/');

    it('every GET route (public anonymous, merchant as store_admin, /admin as super_admin)', async () => {
      const gets = (ROUTES as string[]).filter(r => r.startsWith('GET ')).map(r => r.slice(4));
      await pool(gets, 8, async route => {
        const isPublic = route.startsWith('/public') || route.startsWith('/stores/public');
        const isAdminNs = route.startsWith('/admin') || route.startsWith('/internal');
        const headers: Record<string, string> = isPublic
          ? { 'x-store-id': storeId, 'x-session-id': 'sess-sweep', 'accept-language': 'ar' }
          : { authorization: `Bearer ${isAdminNs ? su : sa}`, 'x-store-id': storeId };
        await hit(
          isPublic ? 'GET-public' : isAdminNs ? 'GET-admin' : 'GET-merchant',
          'GET',
          route,
          BASE + fill(route),
          headers
        );
      });
      if (ONLY.length === 0) expect(results.length).toBeGreaterThan(300);
    }, 600_000);

    it('GET as a logged-in storefront customer (customer-scoped reads)', async () => {
      const mine = (ROUTES as string[])
        .filter(r => r.startsWith('GET '))
        .map(r => r.slice(4))
        .filter(r =>
          /^\/(auth\/me|addresses|me\/|public\/orders|public\/customers|public\/wishlist|public\/cart|public\/loyalty|public\/wallet)/.test(
            r
          )
        );
      await pool(mine, 6, async route =>
        hit('GET-customer', 'GET', route, BASE + fill(route), {
          authorization: `Bearer ${cust}`,
          'x-store-id': storeId,
          'x-session-id': 'sess-sweep',
        })
      );
    }, 300_000);

    it('every mutating route with an empty JSON body (validation must answer before any Postgres read)', async () => {
      const writes = (ROUTES as string[]).filter(r => !r.startsWith('GET ')).map(r => r.split(' '));
      await pool(writes, 8, async ([method, route]) => {
        const isPublic =
          route!.startsWith('/public') ||
          route!.startsWith('/stores/public') ||
          route!.startsWith('/auth');
        const isAdminNs = route!.startsWith('/admin') || route!.startsWith('/internal');
        const headers: Record<string, string> = isPublic
          ? { 'x-store-id': storeId, 'x-session-id': 'sess-sweep' }
          : { authorization: `Bearer ${isAdminNs ? su : sa}`, 'x-store-id': storeId };
        await hit('WRITE-empty', method!, route!, BASE + fill(route!), headers, {});
      });
    }, 600_000);

    it('payment / billing / shipping / alert webhooks (unsigned: must be a 4xx or a retryable 503 from D1, never a Postgres 500)', async () => {
      const hooks: Array<[string, string]> = [
        ['POST', '/webhooks/payment/paymob'],
        ['POST', '/webhooks/payment/tap'],
        ['POST', '/webhooks/payment/myfatoorah'],
        ['POST', '/webhooks/payment/fawry'],
        ['POST', '/webhooks/payment/stripe'],
        ['POST', `/webhooks/payment/paymob/s/${storeId}`],
        ['POST', `/webhooks/payment/tap/s/${storeId}`],
        ['POST', '/webhooks/payment'],
        ['GET', '/webhooks/payment/callback?merchant_order_id=x'],
        ['GET', '/webhooks/payment/error'],
        ['POST', `/webhooks/shipping/bosta/${storeId}/sweep`],
        ['POST', '/webhooks/billing/tap'],
        ['POST', '/webhooks/billing/stripe'],
        ['POST', '/webhooks/billing/paymob'],
        ['POST', '/alerts/webhooks/sentry'],
      ];
      for (const [m, p] of hooks)
        await hit(
          'WEBHOOK',
          m,
          p,
          BASE + p,
          {},
          m === 'POST'
            ? { type: 'TRANSACTION', obj: { id: 1, order: { id: 'sweep-ref' } } }
            : undefined
        );
    }, 120_000);

    it('storefront flow: home, category, search, PDP, cart, checkout quote, order create (up to payment)', async () => {
      const h = { 'x-store-id': storeId, 'x-session-id': 'sess-flow', 'accept-language': 'ar' };
      const adm = { authorization: `Bearer ${sa}`, 'x-store-id': storeId };
      await hit('FLOW', 'GET', '/public/stores/:slug', `${BASE}/public/stores/sweep-shop`, h);
      const cat = await hit(
        'FLOW',
        'POST',
        '/stores/:storeId/categories',
        `${BASE}/stores/${storeId}/categories`,
        adm,
        { name: 'Sweep Cat' }
      );
      const prod = await hit(
        'FLOW',
        'POST',
        '/stores/:storeId/products',
        `${BASE}/stores/${storeId}/products`,
        adm,
        {
          name: 'Sweep Product',
          price: 5000,
          inventory: 10,
          status: 'active',
        }
      );
      let productId = ZERO;
      try {
        const j = (await prod?.clone().json()) as {
          data?: { id?: string; product?: { id?: string } };
        };
        productId = j.data?.id ?? j.data?.product?.id ?? ZERO;
      } catch {
        /* creation failed: the following steps still run against a missing product and are recorded */
      }
      void cat;
      await hit('FLOW', 'GET', '/public/categories', `${BASE}/public/categories`, h);
      await hit('FLOW', 'GET', '/public/products', `${BASE}/public/products`, h);
      await hit(
        'FLOW',
        'GET',
        '/public/products?search=sweep',
        `${BASE}/public/products?search=sweep`,
        h
      );
      await hit('FLOW', 'GET', '/public/products/:id', `${BASE}/public/products/${productId}`, h);
      // a storefront customer: register (the DO customer-auth path, marker set) -> bearer for cart / quote / order
      const reg = await hit('FLOW', 'POST', '/auth/register', `${BASE}/auth/register`, h, {
        email: 'sweep-customer@exit-test.invalid',
        password: 'Sweep-Passw0rd!x',
        firstName: 'Sweep',
        lastName: 'Customer',
        storeId,
      });
      let bearer = '';
      try {
        const j = (await reg?.clone().json()) as {
          data?: { accessToken?: string; tokens?: { accessToken?: string } };
        };
        bearer = j.data?.accessToken ?? j.data?.tokens?.accessToken ?? '';
      } catch {
        /* register failed: the steps below run anonymously and are recorded */
      }
      const ch = bearer ? { ...h, authorization: `Bearer ${bearer}` } : h;
      await hit('FLOW', 'GET', '/public/cart', `${BASE}/public/cart`, ch);
      await hit('FLOW', 'POST', '/public/cart/items', `${BASE}/public/cart/items`, ch, {
        productId,
        quantity: 1,
      });
      await hit('FLOW', 'GET', '/public/cart (after add)', `${BASE}/public/cart`, ch);
      const order = {
        shippingAddress: {
          firstName: 'Sweep',
          lastName: 'Buyer',
          address1: '1 Test St',
          city: 'Cairo',
          phone: '+201000000000',
          country: 'EG',
        },
        paymentMethod: 'cod',
      };
      await hit('FLOW', 'POST', '/public/orders/quote', `${BASE}/public/orders/quote`, ch, order);
      await hit('FLOW', 'POST', '/public/orders', `${BASE}/public/orders`, ch, order);
      await hit('FLOW', 'POST', '/auth/login', `${BASE}/auth/login`, h, {
        email: 'sweep-customer@exit-test.invalid',
        password: 'Sweep-Passw0rd!x',
      });
      await hit('FLOW', 'POST', '/auth/forgot-password', `${BASE}/auth/forgot-password`, h, {
        email: 'sweep-customer@exit-test.invalid',
      });
      await hit(
        'FLOW',
        'POST',
        '/auth/merchant/signup',
        `${BASE}/auth/merchant/signup`,
        {},
        { email: 'm@exit-test.invalid', password: 'Sweep-Passw0rd!x', storeName: 'x' }
      );
    }, 180_000);

    it('cron and job groups for a DO store (scheduled events; outcomes are in the Worker log lines "[cron] job failed")', async () => {
      const api = e.API as unknown as {
        scheduled?(o: { cron: string; scheduledTime?: Date }): Promise<{ outcome: string }>;
      };
      const crons = ['0 * * * *', '*/15 * * * *', '*/30 * * * *', '0 */12 * * *', '0 3 * * *'];
      for (const cron of crons) {
        const t0 = Date.now();
        let outcome = 'ran (job outcomes: Worker log lines "[cron] job done|failed")';
        try {
          outcome =
            (await api.scheduled?.({ cron, scheduledTime: new Date() }))?.outcome ?? outcome;
        } catch (err) {
          outcome = `threw: ${String(err).slice(0, 160)}`;
        }
        const r: Result = {
          group: 'CRON',
          method: 'SCHEDULED',
          route: cron,
          url: cron,
          status: outcome.startsWith('threw') ? -1 : 200,
          ms: Date.now() - t0,
          message: outcome,
        };
        results.push(r);
        // eslint-disable-next-line no-console
        console.log('SWEEP_RESULT ' + JSON.stringify(r));
      }
    }, 300_000);

    it('summary', () => {
      const bad = results.filter(failing);
      const odd = results.filter(
        r => !failing(r) && r.status >= 400 && !EXPECTED_4XX.has(r.status)
      );
      // eslint-disable-next-line no-console
      console.log(
        `SWEEP_SUMMARY total=${results.length} ok2xx=${results.filter(r => r.status >= 200 && r.status < 300).length} expected4xx=${results.filter(r => EXPECTED_4XX.has(r.status)).length} failing=${bad.length} odd=${odd.length}`
      );
      if ((env as unknown as { SWEEP_STRICT?: string }).SWEEP_STRICT === '1')
        expect(bad.map(r => `${r.method} ${r.route} ${r.status}`)).toEqual([]);
    });
  }
);
