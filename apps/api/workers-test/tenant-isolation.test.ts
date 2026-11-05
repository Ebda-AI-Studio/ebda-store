/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * N-17 (NEON-ZERO, Ruling NZ-17-RLS-1): TENANT ISOLATION AS A PROPERTY, on the built Worker + real StoreDOs.
 *
 * This replaces the deleted Postgres RLS cross-tenant read/write denial tests. Two stores exist on the DO backend, A and B; B
 * is seeded with data. Walking the REAL route table (`route-table.json`, the same one the route sweep uses):
 *
 *  1. every route that names a store in its path (`:storeId`, `/stores/:id/...`) is called AUTHENTICATED AS A'S OWNER but with B's
 *     store id (and B's entity ids where the route takes one): it must answer 401/403/404, B's data must not appear in the body,
 *     and B's StoreDO content digest must be unchanged afterwards (a write must not land in B);
 *  2. every other store-scoped route (store chosen by the `x-store-id` header) is called as A's owner with B's header: the body
 *     must carry nothing of B and B's digest must not move;
 *  3. every route that is not public-by-design answers 401 with no credentials; the allowlist of public-by-design prefixes is
 *     explicit and every other route must be 401.
 *
 * SWEEP_STRICT=1 is the CI mode of the route sweep; this file is always strict (there is no measuring mode: isolation either holds
 * or it does not). The route list is asserted non-trivial so a route-table that loses its `:storeId` routes cannot pass empty.
 *
 *   npx vitest run --config vitest.workers.config.mts workers-test/tenant-isolation.test.ts   (after `npm run cf:dry-run`)
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';
import ALL_ROUTES from './route-table.json';

const ROUTES = ALL_ROUTES as string[];

interface StoreDoStub {
  backupNow(storeId: string): Promise<{ tables: Record<string, { rows: number; sha256: string }> }>;
}
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  STORE_DO: { idFromName(n: string): unknown; get(id: unknown): StoreDoStub };
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  E2E_DB: string;
  /** Test-only fault injection (see the scratch-commit proof in the PR): never set in a real run. */
  ISOLATION_PROOF?: string;
};

const BASE = 'https://api.ebda.app/api/v1';
const ZERO = '00000000-0000-4000-8000-000000000001';
const SEED_TOKEN = 'workers-test-seed-token';

/**
 * Routes that are public (or self-authenticating) by design: no bearer is the point. Everything else must answer 401 without one.
 * Each prefix is a decision, not a convenience: a route added under a new prefix is NOT public until it is listed here.
 */
const PUBLIC_BY_DESIGN: Array<{ re: RegExp; why: string }> = [
  {
    re: /^\/public(\/|$)/,
    why: 'anonymous storefront reads/writes (cart, quote), tenant from x-store-id',
  },
  { re: /^\/stores\/public(\/|$)/, why: 'anonymous storefront store lookup' },
  { re: /^\/auth\//, why: 'login/register/refresh/reset are the credential entry points' },
  {
    re: /^\/mcp(\/|$)/,
    why: 'MCP carries its own agent key auth (mcp/agent-auth.ts), answers its own 401 shape',
  },
  {
    re: /^\/payments\/(webhook|callback|return)/,
    why: 'provider webhooks/redirects are authenticated by signature, not bearer',
  },
  {
    re: /^\/internal\//,
    why: 'operator routes use their own secret (answered 401/404 by the secret gate)',
  },
];

/**
 * SHOPPER surface: the tenant IS the path and the principal is an anonymous visitor or a storefront customer, so a merchant of
 * another store is just a visitor here. For these the property is weaker and still checked: nothing of B that a visitor cannot
 * see (no marker in the body), no 5xx, B unchanged. Matched on "METHOD route", one decision per line.
 */
const SHOPPER_BY_DESIGN: Array<{ re: RegExp; why: string }> = [
  { re: /^[A-Z]+ \/public\//, why: 'anonymous storefront' },
  {
    re: /^[A-Z]+ \/stores\/public\//,
    why: 'anonymous storefront lookups (coupon/shipping/promotion preview)',
  },
  {
    re: /^[A-Z]+ \/stores\/:storeId\/cart(\/|$)/,
    why: 'cart: keyed by session/customer, not a staff role',
  },
  { re: /^GET \/stores\/:storeId\/reviews\/product\//, why: 'published reviews are public' },
  { re: /^POST \/stores\/:storeId\/reviews\/$/, why: 'a customer writes a review' },
  { re: /^GET \/stores\/:storeId\/orders\/my\/list$/, why: 'a customer lists their own orders' },
  { re: /^POST \/stores\/:storeId\/orders\/$/, why: 'a customer places an order' },
  { re: /^POST \/stores\/:storeId\/returns\/$/, why: 'a customer requests a return' },
  {
    re: /^(GET|POST) \/payments\/(methods|config|create|instapay\/)/,
    why: 'checkout payment steps (customer / order token)',
  },
];
/**
 * Shopper routes that still reach Postgres directly (answer 500 PostgresRemovedError for any authenticated caller). Not an isolation
 * finding: an un-ported path, listed so the isolation sweep stays green while it is reported. Remove the entry when it is ported
 * (then its `checkStoreAccess` guard, which this route needs for store_admin callers, is exercised by this file too).
 */
const KNOWN_UNPORTED = new Set(['GET /stores/public/:storeId/orders/:orderId/tracking']);
const isShopper = (line: string): boolean => SHOPPER_BY_DESIGN.some(p => p.re.test(line));
const publicByDesign = (route: string, line = ''): boolean =>
  PUBLIC_BY_DESIGN.some(p => p.re.test(route)) || (line !== '' && isShopper(line));

interface Fixture {
  aOwner: string;
  bOwner: string;
  aId: string;
  bId: string;
  bSlug: string;
  bProductId: string;
  bCategoryId: string;
  aTok: string;
  /** Everything of B that a privileged foreign caller must never see. */
  markers: string[];
  /** What even an anonymous visitor to B must never see (B's public catalogue is public by design): owner id, a draft product. */
  privateMarkers: string[];
}
const fx = {} as Fixture;
let nextIp = 0;
const freshIp = (): string => `10.9.${(nextIp >> 8) & 255}.${nextIp++ & 255}`;

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]!);
    })
  );
}

/** Content digest of one StoreDO: the per-table sha256 of a full export (what the nightly backup verifies). */
async function digest(storeId: string): Promise<string> {
  const stub = e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
  const m = await stub.backupNow(storeId);
  return JSON.stringify(
    Object.entries(m.tables)
      .map(([t, v]) => [t, v.rows, v.sha256])
      .sort()
  );
}

const fillFor =
  (storeForPath: string) =>
  (route: string): string => {
    const segs = route.split('/');
    return segs
      .map((s, i) => {
        if (!s.startsWith(':')) return s;
        const prev = segs[i - 1] ?? '';
        if (s === ':storeId' || (s === ':id' && prev === 'stores')) return storeForPath;
        if (/^:(storeSlug|slug)\b/.test(s)) return fx.bSlug;
        if (s === ':productId' || (s === ':id' && prev === 'products')) return fx.bProductId;
        if (s === ':categoryId' || (s === ':id' && prev === 'categories')) return fx.bCategoryId;
        if (/^:(token|key|code|provider)\b/.test(s)) return 'iso';
        return ZERO;
      })
      .join('/');
  };

const namesStore = (route: string): boolean =>
  /(^|\/):storeId\b/.test(route) || /^\/stores\/:id(\/|$)/.test(route);

interface Row {
  method: string;
  route: string;
  status: number;
  leaked: boolean;
}
async function call(
  method: string,
  route: string,
  headers: Record<string, string>
): Promise<{ status: number; text: string }> {
  const res = await e.API.fetch(BASE + route, {
    method,
    headers: {
      'x-forwarded-for': freshIp(),
      ...headers,
      ...(method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
    },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, text: await res.text() };
}

describe.skipIf(e.E2E_DB === '1')(
  'tenant isolation: A cannot read or write B on the DO backend',
  () => {
    it('fixture: stores A and B on the DO, B seeded, a token for A only', async () => {
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
      for (const [i, k] of [
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
      ].entries())
        await e.PLATFORM_DB.prepare(
          'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
        )
          .bind(`iso-marker-${i}`, k)
          .run();
      fx.aOwner = 'owner-iso-a';
      fx.bOwner = 'owner-iso-b';
      fx.bSlug = 'iso-shop-b';
      const make = async (ownerId: string, name: string, slug: string): Promise<string> => {
        const r = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
          method: 'POST',
          body: JSON.stringify({ ownerId, name, slug, operator: true }),
        });
        expect(r.status).toBe(200);
        return ((await r.json()) as { id: string }).id;
      };
      fx.aId = await make(fx.aOwner, 'Iso Shop A', 'iso-shop-a');
      fx.bId = await make(fx.bOwner, 'Iso Shop B', fx.bSlug);
      for (const u of [fx.aOwner, fx.bOwner])
        await authState(`user:tv:${u}`, [['set', `user:tv:${u}`, '0', {}]]);
      fx.aTok = await accessToken({
        userId: fx.aOwner,
        jti: 'j-iso-a',
        role: 'store_admin',
        storeId: fx.aId,
      });

      const draftId = crypto.randomUUID();
      fx.bProductId = crypto.randomUUID();
      fx.bCategoryId = crypto.randomUUID();
      const now = Date.now();
      const seeded = await e.API.fetch(
        `https://api.ebda.app/api/v1/internal/store-do/${fx.bId}/seed`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${SEED_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            products: [
              {
                id: draftId,
                storeId: fx.bId,
                name: 'ISO-B-DRAFT-SECRET',
                slug: 'iso-b-draft',
                price: 9999,
                inventory: 1,
                status: 'draft',
                hasVariants: false,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: fx.bProductId,
                storeId: fx.bId,
                name: 'ISO-B-SECRET-PRODUCT',
                slug: 'iso-b-secret',
                price: 7777,
                inventory: 3,
                status: 'active',
                hasVariants: false,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
        }
      );
      expect(seeded.status).toBe(200);
      // Markers that must never reach A's responses. (B's category id is only an entity id to aim at; B has no category row.)
      fx.markers = [
        fx.bId,
        fx.bSlug,
        'ISO-B-SECRET',
        'Iso Shop B',
        fx.bOwner,
        fx.bProductId,
        draftId,
      ];
      fx.privateMarkers = [fx.bOwner, 'ISO-B-DRAFT-SECRET', draftId];
    });

    it('the digest is a sound instrument: stable when nothing happens, moves when B changes', async () => {
      const d0 = await digest(fx.bId);
      expect(await digest(fx.bId)).toBe(d0);
      const r = await e.API.fetch(`https://api.ebda.app/api/v1/internal/store-do/${fx.bId}/seed`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SEED_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          products: [
            {
              id: crypto.randomUUID(),
              storeId: fx.bId,
              name: 'digest-probe',
              slug: 'digest-probe',
              price: 1,
              inventory: 1,
              status: 'active',
              hasVariants: false,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      });
      expect(r.status).toBe(200);
      expect(await digest(fx.bId)).not.toBe(d0);
    });

    it("every route naming a store: A's owner with B's id gets 401/403/404, nothing of B, and B is unchanged", async () => {
      const targets = ROUTES.filter(r => namesStore(r.split(' ')[1]!) && !isShopper(r)).map(r => {
        const [method, route] = r.split(' ') as [string, string];
        return { method, route };
      });
      // The route table cannot silently lose the property's subject.
      // eslint-disable-next-line no-console
      console.log(`ISOLATION_COVERAGE privileged-store-routes=${targets.length}`);
      expect(targets.length).toBeGreaterThan(500);
      const before = await digest(fx.bId);
      const fill = fillFor(fx.bId);
      const rows: Row[] = [];
      await pool(targets, 8, async ({ method, route }) => {
        const { status, text } = await call(method, fill(route), {
          authorization: `Bearer ${fx.aTok}`,
          'x-store-id': fx.bId,
        });
        rows.push({ method, route, status, leaked: fx.markers.some(m => text.includes(m)) });
      });
      const bad = rows.filter(r => ![401, 403, 404].includes(r.status) || r.leaked);
      // eslint-disable-next-line no-console
      console.log(
        'ISOLATION_STATUS_HISTOGRAM ' +
          JSON.stringify(
            Object.fromEntries(
              [...new Set(rows.map(r => r.status))].map(s => [
                s,
                rows.filter(r => r.status === s).length,
              ])
            )
          )
      );
      expect(
        bad.map(r => `${r.method} ${r.route} -> ${r.status}${r.leaked ? ' LEAK' : ''}`)
      ).toEqual([]);
      expect(await digest(fx.bId)).toBe(before);
    }, 600_000);

    it('the shopper surface (tenant in the path, visitor principal): nothing of B leaks, no 5xx, B is unchanged', async () => {
      const targets = ROUTES.filter(r => isShopper(r)).map(r => {
        const [method, route] = r.split(' ') as [string, string];
        return { method, route };
      });
      // eslint-disable-next-line no-console
      console.log(`ISOLATION_COVERAGE shopper-routes=${targets.length}`);
      expect(targets.length).toBeGreaterThan(40);
      const before = await digest(fx.bId);
      const fill = fillFor(fx.bId);
      const rows: Row[] = [];
      await pool(targets, 8, async ({ method, route }) => {
        const { status, text } = await call(method, fill(route), {
          authorization: `Bearer ${fx.aTok}`,
          'x-store-id': fx.bId,
        });
        rows.push({ method, route, status, leaked: fx.privateMarkers.some(m => text.includes(m)) });
      });
      expect(
        rows
          .filter(
            r => (r.status >= 500 && !KNOWN_UNPORTED.has(`${r.method} ${r.route}`)) || r.leaked
          )
          .map(r => `${r.method} ${r.route} -> ${r.status}${r.leaked ? ' LEAK' : ''}`)
      ).toEqual([]);
      expect(await digest(fx.bId)).toBe(before);
    }, 600_000);

    it("every other store-scoped route: A's owner naming B in x-store-id reads nothing of B and writes nothing to B", async () => {
      const targets = ROUTES.filter(r => {
        const route = r.split(' ')[1]!;
        return !namesStore(route) && !publicByDesign(route, r) && !route.startsWith('/admin');
      }).map(r => {
        const [method, route] = r.split(' ') as [string, string];
        return { method, route };
      });
      // eslint-disable-next-line no-console
      console.log(`ISOLATION_COVERAGE header-scoped-routes=${targets.length}`);
      expect(targets.length).toBeGreaterThan(20);
      const before = await digest(fx.bId);
      const fill = fillFor(fx.bId);
      const rows: Row[] = [];
      await pool(targets, 8, async ({ method, route }) => {
        const { status, text } = await call(method, fill(route), {
          authorization: `Bearer ${fx.aTok}`,
          'x-store-id': fx.bId,
        });
        rows.push({ method, route, status, leaked: fx.markers.some(m => text.includes(m)) });
      });
      expect(
        rows.filter(r => r.leaked).map(r => `${r.method} ${r.route} -> ${r.status} LEAK`)
      ).toEqual([]);
      // A route that answers 2xx for a foreign x-store-id must not have acted on B: its digest is the witness.
      expect(await digest(fx.bId)).toBe(before);
    }, 600_000);

    it('every route that is not public by design answers 401 without credentials', async () => {
      const targets = ROUTES.filter(r => !publicByDesign(r.split(' ')[1]!, r)).map(r => {
        const [method, route] = r.split(' ') as [string, string];
        return { method, route };
      });
      // eslint-disable-next-line no-console
      console.log(`ISOLATION_COVERAGE unauth-routes=${targets.length}`);
      expect(targets.length).toBeGreaterThan(500);
      const fill = fillFor(fx.bId);
      const rows: Row[] = [];
      await pool(targets, 8, async ({ method, route }) => {
        const { status, text } = await call(method, fill(route), { 'x-store-id': fx.bId });
        rows.push({ method, route, status, leaked: fx.markers.some(m => text.includes(m)) });
      });
      expect(
        rows
          .filter(r => r.status !== 401 || r.leaked)
          .map(r => `${r.method} ${r.route} -> ${r.status}${r.leaked ? ' LEAK' : ''}`)
      ).toEqual([]);
    }, 600_000);
  }
);
