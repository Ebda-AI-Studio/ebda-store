/**
 * Regression guard for the storefront loyalty 404 bug (2026-09-25).
 *
 * Background: the storefront (apps/web) calls loyalty endpoints at
 * `/public/:storeId/loyalty/{my-points,my-transactions,join,info}` — see
 * apps/web/src/lib/api.ts (`joinLoyalty`), apps/web/src/app/checkout/
 * CheckoutClient.tsx, and apps/web/src/app/account/loyalty/LoyaltyClient.tsx.
 *
 * The API's loyalty router (apps/api/src/routes/loyalty.routes.ts) used to
 * declare those same customer routes with a REDUNDANT literal '/public'
 * baked into their OWN paths (e.g. '/public/:storeId/loyalty/my-points')
 * while being mounted ONLY at the bare '/stores' prefix in
 * apps/api/src/routes/index.ts. The real resolved path was therefore
 * '/stores/public/:storeId/loyalty/my-points' — matching none of the
 * storefront's calls. Every one of those calls 404'd in production on every
 * live store (verified against api.ebda.app 2026-09-25, see the PR body).
 *
 * This test pins BOTH halves of the fix:
 *   1. The literal path string still lives in the storefront source (so a
 *      future client-side rename doesn't make part 2 vacuous).
 *   2. That exact path, requested through the SAME '/stores' + '/public'
 *      mount pair `routes/index.ts` uses, resolves on the real
 *      loyalty.routes.ts router (not a 404).
 *
 * It fails on the pre-fix code either way: dropping the '/public' mount in
 * index.ts 404s every case below (no listener), and restoring the redundant
 * '/public' prefix inside loyalty.routes.ts 404s them too (the registered
 * path becomes '/public/public/:storeId/...').
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';

// ─── Mocks (declared before the route module is dynamically imported) ─────

vi.mock('@ebda/database', () => ({
  prisma: {},
  LoyaltyTransactionType: {},
}));

let currentUser: { userId: string; role: string; storeId?: string } | undefined = {
  userId: 'customer-1',
  role: 'customer',
  storeId: '11111111-1111-1111-1111-111111111111',
};

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = currentUser;
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
  // Mirrors the real guard: only a 'customer'-role token resolves a
  // customerId — a store_admin/super_admin token must NOT (that's the
  // whole point of customerUserId existing as a separate resolver from a
  // bare `req.user?.userId`).
  customerUserId: (req: any) => (req.user?.role === 'customer' ? req.user.userId : undefined),
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: any, _res: any, next: any) => next(),
}));

const loyaltyService = {
  getCustomerPoints: vi.fn(),
  getTransactionHistory: vi.fn(),
  initializeCustomerPoints: vi.fn(),
  getSettings: vi.fn(),
  getStats: vi.fn(),
  listMembers: vi.fn(),
  updateSettings: vi.fn(),
  awardBonusPoints: vi.fn(),
};

vi.mock('@api/services/loyalty.service', () => ({
  LoyaltyService: loyaltyService,
}));

// ─── App bootstrap — mirrors the mount pair in apps/api/src/routes/index.ts ─
//
// routes/index.ts mounts the WHOLE api under '/api/v1', then the ADMIN
// loyalty router at bare '/stores' and the CUSTOMER-ONLY router at '/public'
// (see the mount comment there). This test reproduces exactly that pair
// against the real router module, rather than importing the whole app (which
// needs Redis/Sentry/etc. wired up).
//
// The two mounts take DIFFERENT routers on purpose — mounting the admin
// router at '/public' too is the defect the last describe block guards.

let app: Express;

async function buildApp(): Promise<Express> {
  const { default: adminRouter, publicLoyaltyRoutes } = await import('@api/routes/loyalty.routes');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores', adminRouter);
  server.use('/api/v1/public', publicLoyaltyRoutes);
  return server;
}

// ─── The storefront's own call sites ────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '../..');

function readWebSource(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, 'apps/web/src', relPath), 'utf-8');
}

// ─── The production mount graph itself (#1995) ──────────────────────────────
//
// buildApp() above hand-wires '/stores' -> adminRouter and '/public' ->
// publicLoyaltyRoutes directly against the real loyalty.routes.ts module — it
// never imports or reads apps/api/src/routes/index.ts, the file that
// actually mounts the production router graph. A regression THERE (re-adding
// `router.use('/public', loyaltyRoutes)` — the whole admin router — or
// dropping the '/public' mount entirely) would reach production 404ing or
// re-exposing the admin surface, and this suite would not see it: it tests
// its own idealized mount, not the one Express actually serves.
//
// Read the real file instead of importing it — index.ts wires in Redis,
// Sentry and dozens of other route modules that have no place in a route
// unit test.
function readIndexRoutes(): string {
  return readFileSync(path.join(REPO_ROOT, 'apps/api/src/routes/index.ts'), 'utf-8');
}

describe('the real router graph mounts loyalty the same way this suite tests it (#1995)', () => {
  it("mounts the admin router ('loyaltyRoutes') at '/stores'", () => {
    const src = readIndexRoutes();
    expect(src).toMatch(/router\.use\(\s*'\/stores'[^)]*\bloyaltyRoutes\b\s*\)/);
  });

  it("mounts the customer router ('publicLoyaltyRoutes') at '/public'", () => {
    const src = readIndexRoutes();
    expect(src).toMatch(/router\.use\(\s*'\/public'[^)]*\bpublicLoyaltyRoutes\b\s*\)/);
  });

  it("never mounts the admin router ('loyaltyRoutes') at '/public'", () => {
    // The regression this whole test file exists to prevent: mounting the
    // WHOLE loyalty router (not just the customer-only export) at '/public'
    // republishes admin endpoints where csrfProtection and
    // restrictPlatformOnlyOrigins both stop applying (see the header
    // comment on the describe block below).
    const src = readIndexRoutes();
    const publicMounts = [...src.matchAll(/router\.use\(\s*'\/public'([^;]*)\)/g)].map(m => m[1]);
    for (const args of publicMounts) {
      expect(args).not.toMatch(/\bloyaltyRoutes\b/);
    }
  });
});

const STORE_ID = '11111111-1111-1111-1111-111111111111';

interface ClientCall {
  /** File the call site lives in, for the assertion message only. */
  file: string;
  /** Exact literal substring expected in that file's source. */
  literal: string;
  method: 'GET' | 'POST';
  /** Route template using Express param syntax. */
  routeTemplate: string;
}

const CLIENT_CALLS: ClientCall[] = [
  {
    file: 'lib/api.ts',
    literal: '`/public/${storeId}/loyalty/join`',
    method: 'POST',
    routeTemplate: '/public/:storeId/loyalty/join',
  },
  {
    file: 'app/checkout/CheckoutClient.tsx',
    literal: '`/public/${store.id}/loyalty/my-points`',
    method: 'GET',
    routeTemplate: '/public/:storeId/loyalty/my-points',
  },
  {
    file: 'app/checkout/CheckoutClient.tsx',
    literal: '`/public/${store.id}/loyalty/info`',
    method: 'GET',
    routeTemplate: '/public/:storeId/loyalty/info',
  },
  {
    file: 'app/account/loyalty/LoyaltyClient.tsx',
    literal: '`${API_URL}/public/${storeId}/loyalty/my-points`',
    method: 'GET',
    routeTemplate: '/public/:storeId/loyalty/my-points',
  },
  {
    file: 'app/account/loyalty/LoyaltyClient.tsx',
    literal: '`${API_URL}/public/${storeId}/loyalty/my-transactions`',
    method: 'GET',
    routeTemplate: '/public/:storeId/loyalty/my-transactions',
  },
];

describe('storefront loyalty client paths resolve on the real API router', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = {
      userId: 'customer-1',
      role: 'customer',
      storeId: '11111111-1111-1111-1111-111111111111',
    };
    loyaltyService.getCustomerPoints.mockResolvedValue(null);
    loyaltyService.getTransactionHistory.mockResolvedValue({ transactions: [], meta: {} });
    loyaltyService.initializeCustomerPoints.mockResolvedValue({ points: 100 });
    loyaltyService.getSettings.mockResolvedValue({ loyaltyEnabled: false, settings: {} });
  });

  it.each(CLIENT_CALLS)(
    '$file calls $literal, and that path resolves on the API router',
    async ({ file, literal, method, routeTemplate }) => {
      const source = readWebSource(file);
      expect(source, `expected ${file} to still call ${literal}`).toContain(literal);

      const url = `/api/v1${routeTemplate.replace(':storeId', STORE_ID)}`;
      const res =
        method === 'GET' ? await request(app).get(url) : await request(app).post(url).send({});

      expect(
        res.status,
        `expected ${method} ${url} to resolve on the mounted router (not 404)`
      ).not.toBe(404);
    }
  );

  it('admin loyalty routes stay reachable at the /stores mount (not regressed by the /public addition)', async () => {
    currentUser = { userId: 'admin-1', role: 'store_admin' };
    const res = await request(app).get(`/api/v1/stores/${STORE_ID}/loyalty/settings`);
    expect(res.status).not.toBe(404);
  });
});

describe('public/customer loyalty routes — behavior + tenancy', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = {
      userId: 'customer-1',
      role: 'customer',
      storeId: '11111111-1111-1111-1111-111111111111',
    };
    loyaltyService.getCustomerPoints.mockResolvedValue(null);
    loyaltyService.getTransactionHistory.mockResolvedValue({ transactions: [], meta: {} });
    loyaltyService.initializeCustomerPoints.mockResolvedValue({ points: 100 });
    loyaltyService.getSettings.mockResolvedValue({ loyaltyEnabled: false, settings: {} });
  });

  it('GET .../loyalty/info needs no auth and reports the store disabled state', async () => {
    loyaltyService.getSettings.mockResolvedValue({ loyaltyEnabled: false, settings: {} });
    currentUser = undefined;

    const res = await request(app).get(`/api/v1/public/${STORE_ID}/loyalty/info`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { enabled: false } });
    expect(loyaltyService.getSettings).toHaveBeenCalledWith(STORE_ID);
  });

  it('GET .../loyalty/info reports public-safe fields when the store has loyalty enabled', async () => {
    loyaltyService.getSettings.mockResolvedValue({
      loyaltyEnabled: true,
      settings: {
        pointsPerMajorUnit: 1,
        signupBonus: 100,
        pointsValue: 1,
        minRedeemPoints: 50,
        maxRedeemPercentage: 50,
        tiers: { bronze: { minPoints: 0, multiplier: 1 } },
      },
    });

    const res = await request(app).get(`/api/v1/public/${STORE_ID}/loyalty/info`);

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.pointsPerMajorUnit).toBe(1);
    // The checkout estimate needs the redemption cap the server applies (#181).
    expect(res.body.data.maxRedeemPercentage).toBe(50);
  });

  it('GET .../loyalty/my-points rejects a non-customer (e.g. an admin) token with 403', async () => {
    currentUser = { userId: 'admin-1', role: 'store_admin' };

    const res = await request(app).get(`/api/v1/public/${STORE_ID}/loyalty/my-points`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(loyaltyService.getCustomerPoints).not.toHaveBeenCalled();
  });

  it('GET .../loyalty/my-points scopes the lookup to the requested store + the authenticated customer', async () => {
    loyaltyService.getCustomerPoints.mockResolvedValue({ points: 250, tier: 'silver' });

    const res = await request(app).get(`/api/v1/public/${STORE_ID}/loyalty/my-points`);

    expect(res.status).toBe(200);
    expect(res.body.data.points).toEqual({ points: 250, tier: 'silver' });
    expect(loyaltyService.getCustomerPoints).toHaveBeenCalledWith(STORE_ID, 'customer-1');
  });

  it('GET .../loyalty/my-transactions returns the customer transaction history', async () => {
    loyaltyService.getTransactionHistory.mockResolvedValue({
      transactions: [{ id: 't1', points: 50 }],
      meta: { page: 1, limit: 50, total: 1, totalPages: 1 },
    });

    const res = await request(app).get(`/api/v1/public/${STORE_ID}/loyalty/my-transactions`);

    expect(res.status).toBe(200);
    expect(res.body.data.transactions).toHaveLength(1);
    expect(loyaltyService.getTransactionHistory).toHaveBeenCalledWith(
      STORE_ID,
      'customer-1',
      expect.any(Object)
    );
  });

  it('POST .../loyalty/join enrols the authenticated customer and returns 201', async () => {
    loyaltyService.initializeCustomerPoints.mockResolvedValue({ points: 100 });

    const res = await request(app).post(`/api/v1/public/${STORE_ID}/loyalty/join`).send({});

    expect(res.status).toBe(201);
    expect(res.body.data.points).toEqual({ points: 100 });
    expect(loyaltyService.initializeCustomerPoints).toHaveBeenCalledWith(
      STORE_ID,
      'customer-1',
      true
    );
  });

  it('POST .../loyalty/join rejects a non-customer token with 403 and never calls the service', async () => {
    currentUser = { userId: 'admin-1', role: 'store_admin' };

    const res = await request(app).post(`/api/v1/public/${STORE_ID}/loyalty/join`).send({});

    expect(res.status).toBe(403);
    expect(loyaltyService.initializeCustomerPoints).not.toHaveBeenCalled();
  });
});

// ─── The admin half must NOT be reachable under '/public' ──────────────────
//
// The first version of the 404 fix mounted the WHOLE loyalty router at both
// '/stores' and '/public'. That silently republished every admin endpoint at
// '/public/:storeId/loyalty/...', where two global controls in
// middleware/security.ts stop applying because both are keyed on the path
// prefix rather than on the route's own middleware chain:
//
//   - csrfProtection returns next() for any path containing '/public/'
//     (security.ts) — so PUT .../loyalty/settings and POST .../award become
//     cookie-authenticated writes with no CSRF token check.
//   - restrictPlatformOnlyOrigins denies non-platform origins only under
//     '^/api/v1/stores(/|$)'. CORS allowlists every merchant-registered
//     custom domain with credentials:true, so a merchant-controlled page
//     could lure a signed-in store_admin/super_admin and read
//     .../loyalty/members and .../loyalty/transactions cross-origin —
//     customer first/last name, email and order numbers.
//
// authenticate/authorize/requireStoreAccess do not close either hole (they
// bound WHICH stores the lured admin reaches, not whether the attacker's page
// may spend that admin's cookie), which is why this is a MOUNT-shape gate and
// not an assertion about middleware. The mocks above make every auth guard a
// pass-through precisely so a wrong mount answers 200 here instead of 401.
describe('admin loyalty routes are not republished under the /public mount', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // A super_admin is the worst case: requireStoreAccess bounds them to
    // every store.
    currentUser = { userId: 'admin-1', role: 'super_admin' };
    loyaltyService.getSettings.mockResolvedValue({ loyaltyEnabled: true, settings: {} });
    loyaltyService.getStats.mockResolvedValue({});
    loyaltyService.listMembers.mockResolvedValue({ members: [], meta: {} });
    loyaltyService.getCustomerPoints.mockResolvedValue({ points: 0 });
    loyaltyService.updateSettings.mockResolvedValue({});
    loyaltyService.awardBonusPoints.mockResolvedValue({});
  });

  const ADMIN_ROUTES: Array<{ method: 'GET' | 'PUT' | 'POST'; path: string }> = [
    { method: 'GET', path: `/${STORE_ID}/loyalty/settings` },
    { method: 'PUT', path: `/${STORE_ID}/loyalty/settings` },
    { method: 'GET', path: `/${STORE_ID}/loyalty/stats` },
    { method: 'GET', path: `/${STORE_ID}/loyalty/members` },
    { method: 'GET', path: `/${STORE_ID}/loyalty/members/customer-1` },
    { method: 'GET', path: `/${STORE_ID}/loyalty/members/customer-1/transactions` },
    { method: 'POST', path: `/${STORE_ID}/loyalty/members/customer-1/award` },
    { method: 'GET', path: `/${STORE_ID}/loyalty/transactions` },
  ];

  async function callAdminRoute(mount: string, method: 'GET' | 'PUT' | 'POST', routePath: string) {
    const url = `/api/v1/${mount}${routePath}`;
    const agent = request(app);
    const res =
      method === 'GET'
        ? await agent.get(url)
        : method === 'PUT'
          ? await agent.put(url).send({ loyaltyEnabled: true })
          : await agent.post(url).send({ points: 100, type: 'earn_manual' });
    return { url, status: res.status };
  }

  it.each(ADMIN_ROUTES)(
    '$method /public$path is 404 (CSRF + origin gates skip /public/)',
    async ({ method, path: routePath }) => {
      const { url, status } = await callAdminRoute('public', method, routePath);

      expect(status, `${method} ${url} must not resolve on the /public mount`).toBe(404);
    }
  );

  it.each(ADMIN_ROUTES)(
    '$method /stores$path still resolves on the admin mount',
    async ({ method, path: routePath }) => {
      const { url, status } = await callAdminRoute('stores', method, routePath);

      expect(status, `${method} ${url} must stay reachable for admins`).not.toBe(404);
    }
  );
});
