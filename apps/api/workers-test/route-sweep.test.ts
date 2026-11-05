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

const ROUTES: string[] = ALL_ROUTES as string[];

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  /** Test-worker bindings (vitest.workers.config.mts): the host's env does not reach workerd's `process.env`. */
  SWEEP_STRICT?: string;
  SWEEP_FILTER?: string;
};

/** `SWEEP_FILTER=<regex>` runs only the routes whose `METHOD /path` matches (the strict assertion then covers that subset). */
const FILTER = e.SWEEP_FILTER ? new RegExp(e.SWEEP_FILTER) : undefined;
const inSubset = (line: string) => !e.SWEEP_FILTER || new RegExp(e.SWEEP_FILTER).test(line);

const BASE = 'https://api.ebda.app/api/v1';
const ZERO = '00000000-0000-4000-8000-000000000001';
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
  // SWEEP_FILTER=<regex over "METHOD /route">: measure a subset (a group owner re-checks only its routes).
  if (!inSubset(`${method} ${route}`)) return undefined;
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

/** A 503 that says an optional third-party service is not configured is the correct answer of a Worker without it. */
const NOT_CONFIGURED = new Set([
  'PUSH_NOT_CONFIGURED',
  'STORAGE_NOT_CONFIGURED',
  'alerts_not_configured',
]);
const failing = (r: Result) =>
  r.status < 0 || (r.status >= 500 && !(r.status === 503 && r.code && NOT_CONFIGURED.has(r.code)));

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
      const gets = (ROUTES as string[])
        .filter(r => r.startsWith('GET ') && inSubset(r))
        .map(r => r.slice(4));
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
      if (!e.SWEEP_FILTER) expect(results.length).toBeGreaterThan(300);
    }, 600_000);

    it('GET as a logged-in storefront customer (customer-scoped reads)', async () => {
      const mine = (ROUTES as string[])
        .filter(r => r.startsWith('GET ') && inSubset(r))
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
      const writes = (ROUTES as string[])
        .filter(r => !r.startsWith('GET ') && inSubset(r))
        .map(r => r.split(' '));
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

    it.skipIf(!!FILTER)(
      'payment / billing / shipping / alert webhooks (unsigned: must be a 4xx or a retryable 503 from D1, never a Postgres 500)',
      async () => {
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
      },
      120_000
    );

    it('SEEDED hub writes: valid bodies reach past validation with Postgres dead (stores, plans, billing, users, store delete)', async () => {
      const adm = { authorization: `Bearer ${su}`, 'x-store-id': storeId };
      const seeded: Array<[string, string, string, Record<string, string>, unknown]> = [
        [
          'PUT',
          '/admin/stores/:id',
          `/admin/stores/${storeId}`,
          adm,
          { name: 'Sweep Shop Renamed' },
        ],
        [
          'PATCH',
          '/admin/stores/:id/status',
          `/admin/stores/${storeId}/status`,
          adm,
          { status: 'active' },
        ],
        [
          'PUT',
          '/admin/stores/:id/plan',
          `/admin/stores/${storeId}/plan`,
          adm,
          { plan: 'starter' },
        ],
        [
          'PUT',
          '/admin/stores/:id/subscription',
          `/admin/stores/${storeId}/subscription`,
          adm,
          { planCode: 'basic' },
        ],
        [
          'POST',
          '/admin/stores/:id/manual-payment',
          `/admin/stores/${storeId}/manual-payment`,
          adm,
          {
            planCode: 'basic',
            interval: 'monthly',
            amountMinor: 49900,
            method: 'instapay',
            reference: 'SWEEP-REF-001',
            paidAt: new Date().toISOString(),
          },
        ],
        [
          'POST',
          '/admin/stores',
          '/admin/stores',
          adm,
          {
            storeName: 'Sweep Provisioned',
            storeSlug: 'sweep-provisioned',
            ownerEmail: 'prov-owner@exit-test.invalid',
            ownerName: 'Prov Owner',
          },
        ],
        [
          'POST',
          '/admin/users',
          '/admin/users',
          adm,
          {
            email: 'invitee@exit-test.invalid',
            firstName: 'In',
            lastName: 'Vitee',
            role: 'store_admin',
          },
        ],
        ['PUT', '/admin/users/:id', `/admin/users/${owner}`, adm, { status: 'active' }],
        [
          'PUT',
          '/admin/users/:id (email)',
          `/admin/users/${owner}`,
          adm,
          { email: 'takeover@exit-test.invalid' },
        ],
        [
          'PUT',
          '/admin/users/:id (super_admin target)',
          '/admin/users/00000000-0000-4000-8000-0000000000aa',
          adm,
          { firstName: 'Mallory' },
        ],
        ['GET', '/admin/users?search=sweep', '/admin/users?search=sweep', adm, undefined],
        // Ruling NZ-PG-2: with Postgres dead the account is the identity service's and the event is found by a probe of the
        // stores' DOs: an answer, never the 500 of a Postgres definer.
        [
          'POST',
          '/admin/impersonate (unknown user)',
          '/admin/impersonate',
          adm,
          { userId: '00000000-0000-4000-8000-0000000000bb' },
        ],
        [
          'GET',
          '/payments/events/:eventId/payload (unknown event)',
          '/payments/events/00000000-0000-4000-8000-0000000000cc/payload',
          adm,
          undefined,
        ],
      ];
      for (const [m, route, path, headers, body] of seeded) {
        if (!inSubset(`${m} ${route}`)) continue;
        const res = await hit('SEEDED', m, route, BASE + path, headers, body);
        // The admin route never edits an e-mail (account takeover) and never edits ANOTHER super_admin's profile.
        if (route === '/admin/users/:id (email)') expect(res?.status).toBe(409);
        if (route === '/admin/users/:id (super_admin target)') expect(res?.status).toBe(403);
        // the accounts stub answers a state for every id, so the unknown user may be a 200 here; the point is: not a 5xx
        if (route.endsWith('(unknown user)')) expect([200, 404]).toContain(res?.status);
        if (route.endsWith('(unknown event)')) expect(res?.status).toBe(404);
      }
      // A second store, created like the first (D1 + DO), deleted by its owner: the DO delete path (close, finish, directory).
      const extra = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
        method: 'POST',
        body: JSON.stringify({
          ownerId: owner,
          name: 'Doomed',
          slug: 'sweep-doomed',
          operator: true,
        }),
      });
      if (extra.status === 200 && inSubset('DELETE /stores/:id')) {
        const doomedId = ((await extra.json()) as { id: string }).id;
        await hit('SEEDED', 'DELETE', '/stores/:id (DO store)', `${BASE}/stores/${doomedId}`, {
          authorization: `Bearer ${su}`,
          'x-store-id': doomedId,
        });
      }
    }, 180_000);

    it.skipIf(!!FILTER)(
      'storefront flow: home, category, search, PDP, cart, checkout quote, order create (up to payment)',
      async () => {
        // Its OWN store: the empty-body write sweep above cancels the sweep store's subscription (billing routes), which would
        // make the order gate answer 402 SUBSCRIPTION_REQUIRED for a reason that has nothing to do with Postgres.
        const made = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
          method: 'POST',
          body: JSON.stringify({
            ownerId: 'owner-flow',
            name: 'Flow Shop',
            slug: 'flow-shop',
            operator: true,
          }),
        });
        expect(made.status).toBe(200);
        const storeId = ((await made.json()) as { id: string }).id;
        await authState('user:tv:owner-flow', [['set', 'user:tv:owner-flow', '0', {}]]);
        const sa = await accessToken({
          userId: 'owner-flow',
          jti: 'j-flow',
          role: 'store_admin',
          storeId,
        });
        const h = { 'x-store-id': storeId, 'x-session-id': 'sess-flow', 'accept-language': 'ar' };
        const adm = { authorization: `Bearer ${sa}`, 'x-store-id': storeId };
        await hit('FLOW', 'GET', '/public/stores/:slug', `${BASE}/public/stores/flow-shop`, h);
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
        if (productId === ZERO) {
          // Product create is its own fix (group B). The cart / quote / order steps below must not be skipped meanwhile:
          // seed one product through the operator seed route so they run against a real, priced, in-stock row.
          const seeded = crypto.randomUUID();
          const now = Date.now();
          const r = await e.API.fetch(
            `https://api.ebda.app/api/v1/internal/store-do/${storeId}/seed`,
            {
              method: 'POST',
              headers: {
                authorization: 'Bearer workers-test-seed-token',
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                products: [
                  {
                    id: seeded,
                    storeId,
                    name: 'Seeded Sweep Product',
                    slug: 'seeded-sweep',
                    price: 5000,
                    inventory: 10,
                    status: 'active',
                    hasVariants: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              }),
            }
          );
          if (r.status === 200) productId = seeded;
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
      },
      180_000
    );

    it.skipIf(!!FILTER)(
      'cron and job groups for a DO store (scheduled events; outcomes are in the Worker log lines "[cron] job failed")',
      async () => {
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
      },
      300_000
    );

    it('summary', () => {
      const bad = results.filter(failing);
      const odd = results.filter(
        r => !failing(r) && r.status >= 400 && !EXPECTED_4XX.has(r.status)
      );
      // eslint-disable-next-line no-console
      console.log(
        `SWEEP_SUMMARY total=${results.length} ok2xx=${results.filter(r => r.status >= 200 && r.status < 300).length} expected4xx=${results.filter(r => EXPECTED_4XX.has(r.status)).length} failing=${bad.length} odd=${odd.length}`
      );
      if (e.SWEEP_STRICT === '1') {
        const lines = bad.map(r => `${r.method} ${r.route} ${r.status}`);
        // eslint-disable-next-line no-console
        if (lines.length) console.log('SWEEP_FAILING\n' + lines.join('\n'));
        expect(lines, 'routes answering 5xx or hanging').toEqual([]);
      }
    });
  }
);
