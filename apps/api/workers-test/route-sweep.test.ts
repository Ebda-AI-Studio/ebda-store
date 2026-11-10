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
import { DEFAULT_PLAN_SEEDS, FEATURE_KEYS_ARRAY } from '@ebda/shared';
import { accessToken, authState } from './helpers';
import ALL_ROUTES from './route-table.json';
import ALL_CRONS from './cron-list.json';

const ROUTES: string[] = ALL_ROUTES as string[];

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
  /** Test-worker bindings (vitest.workers.config.mts): the host's env does not reach workerd's `process.env`. */
  SWEEP_STRICT?: string;
  SWEEP_FILTER?: string;
};

/** `SWEEP_FILTER=<regex>` runs only the routes whose `METHOD /path` matches (the strict assertion then covers that subset). */
const FILTER = e.SWEEP_FILTER ? new RegExp(e.SWEEP_FILTER) : undefined;
const inSubset = (line: string) => !e.SWEEP_FILTER || new RegExp(e.SWEEP_FILTER).test(line);

/** Cron job names whose Postgres reaches are tolerated. MUST stay empty for DO stores (Ruling NZ-PG-8). */
const CRON_PG_ALLOWLIST: RegExp[] = [];

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
    let jobsStoreId = '';
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
      // #465: a SECOND fixture store with every feature on (D1 `store_features`, the override row super-admin's toggle writes) for
      // the cron group. A job body that checks a feature returns BEFORE its store reads when the store lacks it, so a broken
      // read behind the gate stayed green (the #463 low-stock `owner` fix could be reverted with the sweep still passing).
      // Every store runs through /__dev/run-jobs.
      const jobsShop = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
        method: 'POST',
        body: JSON.stringify({
          ownerId: owner,
          name: 'Jobs Shop',
          slug: 'sweep-jobs-shop',
          operator: true,
        }),
      });
      expect(jobsShop.status).toBe(200);
      jobsStoreId = ((await jobsShop.json()) as { id: string }).id;
      // The route fixture store ALSO runs with every feature on: a gated route answers 403/404 before its store reads when the
      // feature is off, so a feature-default fixture hid 33 unported gated routes (finance, loyalty, wallets, affiliates...).
      for (const [sid, tag] of [
        [jobsStoreId, 'jobs'],
        [storeId, 'route'],
      ] as const)
        for (const key of FEATURE_KEYS_ARRAY)
          await e.PLATFORM_DB.prepare(
            'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
          )
            .bind(`sweep-feat-${tag}-${key}`, sid, key, Date.now())
            .run();
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
        // register returns no tokens (enumeration close), so the customer-owned order the tracking cases need uses a minted bearer
        if (!bearer) {
          await authState('user:tv:cust-track', [['set', 'user:tv:cust-track', '0', {}]]);
          bearer = await accessToken({
            userId: 'cust-track',
            jti: 'j-cust-track',
            role: 'customer',
            storeId,
          });
        }
        const ch = { ...h, authorization: `Bearer ${bearer}` };
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
        const placed = await hit(
          'FLOW',
          'POST',
          '/public/orders',
          `${BASE}/public/orders`,
          ch,
          order
        );
        // Public order tracking on a DO store (was prisma.order.findFirst -> 500 PostgresRemovedError). The shopper's own
        // bearer sees the order; every other proof answers like a missing order (404) or is refused (401), never 5xx.
        let placedId = '';
        try {
          const j = (await placed?.clone().json()) as {
            data?: { id?: string; order?: { id?: string } };
          };
          placedId = j.data?.id ?? j.data?.order?.id ?? '';
        } catch {
          /* order create failed: the tracking assertions below then fail loudly */
        }
        const trackUrl = (sid: string, oid: string) =>
          `${BASE}/stores/public/${sid}/orders/${oid}/tracking`;
        const track = async (
          label: string,
          sid: string,
          oid: string,
          hdr: Record<string, string>
        ) =>
          hit(
            'TRACKING',
            'GET',
            `/stores/public/:storeId/orders/:orderId/tracking (${label})`,
            trackUrl(sid, oid),
            hdr
          );
        expect(placedId, 'order id from POST /public/orders').not.toBe('');
        const ok = await track('own order', storeId, placedId, ch);
        expect(ok?.status).toBe(200);
        const okBody = (await ok!.json()) as {
          data: { orderNumber: string; shipment: unknown };
        };
        expect(okBody.data.orderNumber).toBeTruthy();
        expect(okBody.data.shipment).toBeNull();
        const missing = await track('unknown order', storeId, ZERO, ch);
        expect(missing?.status).toBe(404);
        const otherStore = await track('wrong store', ZERO, placedId, ch);
        expect(otherStore?.status).toBe(404);
        // another customer of the same store: same 404 as a missing order (no existence oracle)
        const other = await accessToken({
          userId: 'cust-other',
          jti: 'j-cust-other',
          role: 'customer',
          storeId,
        });
        await authState('user:tv:cust-other', [['set', 'user:tv:cust-other', '0', {}]]);
        const stranger = await track('other customer', storeId, placedId, {
          ...h,
          authorization: `Bearer ${other}`,
        });
        expect(stranger?.status).toBe(404);
        const anon = await track('anonymous', storeId, placedId, h);
        expect(anon?.status).toBe(401);
        // Sign-in needs a VERIFIED customer (an unverified one is refused 403 EMAIL_NOT_VERIFIED before any session is issued,
        // so the session-issue path would go unswept). `/auth/register` mails its token and returns none, so this customer is
        // written to the store's DO with a known token and verified through the real route.
        const verifyToken = `${storeId}~${'c'.repeat(64)}`;
        const tokenHash = [
          ...new Uint8Array(
            await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifyToken))
          ),
        ]
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        const seededCustomer = await e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).authOp(
          storeId,
          'register',
          JSON.stringify({
            id: 'sweep-verified',
            email: 'sweep-verified@exit-test.invalid',
            // bcrypt cost 4 of the password below (test fixture only)
            passwordHash: '$2b$04$jYDlZaJj/X/kmBmzPXDwsOP4.aIZ2IBm.rDUDGyiC8iKKUZPb/Rzm',
            firstName: 'Sweep',
            lastName: 'Verified',
            verification: {
              tokenHash,
              expiresAt: Date.now() + 3_600_000,
              rowId: 'v-sweep-verified',
            },
          })
        );
        expect(seededCustomer.ok, JSON.stringify(seededCustomer)).toBe(true);
        const verifiedEmail = await hit(
          'FLOW',
          'POST',
          '/auth/verify-email',
          `${BASE}/auth/verify-email`,
          h,
          { token: verifyToken }
        );
        const signedIn = await hit('FLOW', 'POST', '/auth/login', `${BASE}/auth/login`, h, {
          email: 'sweep-verified@exit-test.invalid',
          password: 'Passw0rd!xyz',
          storeId,
        });
        // `hit` answers undefined when SWEEP_FILTER leaves the route out
        if (verifiedEmail) expect(verifiedEmail.status).toBe(200);
        if (signedIn) expect(signedIn.status).toBe(200);
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
        // EVERY Cron Trigger in wrangler.jsonc (tests/unit/sweep-cron-list.test.ts pins this file to it), not a sample.
        const crons: string[] = ALL_CRONS;
        // Every access to the Postgres client from here on is counted by the Worker (DEV_STATS=1; packages/database
        // request-db.ts `postgresReaches`). A job that catches its own error still shows up here.
        const pgReaches = async (reset: boolean) =>
          (
            (await (
              await e.API.fetch(`https://api.ebda.app/__dev/pg-reaches${reset ? '?reset=1' : ''}`, {
                headers: { 'x-forwarded-for': freshIp() },
              })
            ).json()) as { reaches: Array<{ label: string; stack: string }> }
          ).reaches;
        // The nightly backup sweep reports a store with no manifest from YESTERDAY as missing. Every store in this run is minutes
        // old, so give each one yesterday's manifest: the sweep then measures the job, not the age of the fixture.
        const bucket = (
          env as unknown as {
            STORE_BACKUPS: {
              put(k: string, v: string): Promise<unknown>;
              get(k: string): Promise<{ text(): Promise<string> } | null>;
            };
          }
        ).STORE_BACKUPS;
        const day = (d: Date) => d.toISOString().slice(0, 10);
        const yesterday = day(new Date(Date.now() - 86_400_000));
        const stores = (
          await (
            e.PLATFORM_DB as unknown as {
              prepare(s: string): { all<T>(): Promise<{ results: T[] }> };
            }
          )
            .prepare("SELECT id FROM stores WHERE storage_backend = 'do'")
            .all<{ id: string }>()
        ).results;
        for (const s of stores)
          await bucket.put(`store-do-backups/${s.id}/${yesterday}/manifest.json`, '{}');
        await pgReaches(true);
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
        // Every cron-triggered job BODY and the Postgres-adjacent queue messages (pg-copy-scrub), run through the consumers' own
        // guard: a cron only STARTS most jobs (queue/workflow), so the bodies are driven here. Reaches are counted below.
        const ran = await e.API.fetch('https://api.ebda.app/__dev/run-jobs', {
          method: 'POST',
          headers: { 'x-forwarded-for': freshIp() },
        });
        expect(ran.status, 'the dev run-jobs endpoint answered').toBe(200);
        // eslint-disable-next-line no-console
        const ranBody = (await ran.json()) as {
          jobs: Array<{ id: string; ok: boolean; error?: string }>;
        };
        console.log('SWEEP_JOBS_RAN ' + JSON.stringify(ranBody));
        expect(
          ranBody.jobs.some(j => j.id.endsWith(`@${jobsStoreId}`)),
          'the feature-complete fixture store was driven through the alarm jobs'
        ).toBe(true);
        // A job body (cron run AND each DO store's alarm run) that answers a store-read refusal or a removed-Postgres error is a
        // port defect (2026-11-06: stock-low-stock-alert-cron, STORE_RECORD_REFUSED). Other failures (provider keys...) are not ours.
        const portDefects = ranBody.jobs.filter(
          j =>
            !j.ok &&
            /POSTGRES_REMOVED|STORE_RECORD_REFUSED|STORE_READ_UNSUPPORTED|not available on the StoreDO read path/.test(
              j.error ?? ''
            )
        );
        if (e.SWEEP_STRICT === '1')
          expect(portDefects, 'job bodies that hit a DO store-read refusal or Postgres').toEqual(
            []
          );
        const report = await bucket.get(`ops-reports/backup-sweep/${day(new Date())}.json`);
        const backup = report
          ? (JSON.parse(await report.text()) as {
              ok: boolean;
              stores: { errors: string[]; missingYesterday: string[] };
              d1: Record<string, { ok: boolean; error?: string }>;
            })
          : null;
        // eslint-disable-next-line no-console
        console.log('SWEEP_BACKUP_REPORT ' + JSON.stringify(backup));
        expect(backup, 'the 03:00 cron wrote the backup sweep report').not.toBeNull();
        expect(backup!.ok, JSON.stringify(backup)).toBe(true);
        // Postgres is dead for a DO store: NO cron job may reach it. The allowlist is EMPTY (Ruling NZ-PG-8); an entry would
        // have to name the job and a reason a DO store still needs Postgres, which is a defect to port, not to allow.
        const reached = (await pgReaches(false)).filter(
          x => !CRON_PG_ALLOWLIST.some(re => re.test(x.label))
        );
        for (const x of reached)
          // eslint-disable-next-line no-console
          console.log('SWEEP_CRON_PG_REACH ' + JSON.stringify(x));
        if (e.SWEEP_STRICT === '1')
          expect(
            reached.map(x => x.label),
            'cron jobs that reached the Postgres client'
          ).toEqual([]);
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
