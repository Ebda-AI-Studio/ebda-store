/**
 * Guard for #1993: NO admin route may be reachable under `/api/v1/public`.
 *
 * Two global controls in apps/api/src/middleware/security.ts are keyed on the
 * PATH PREFIX, not on the route's own middleware chain:
 *   - `csrfProtection` returns next() for any path containing '/public/';
 *   - `restrictPlatformOnlyOrigins` denies non-platform origins only under
 *     '/api/v1/stores'.
 * CORS allowlists every merchant-registered custom domain with
 * credentials:true. So an admin route (authorize(store_admin|super_admin) /
 * requireStoreAccess) republished under '/public' is a CSRF-free,
 * credentialed cross-origin target: a merchant-controlled storefront page
 * could drive a signed-in admin's browser into it. Five routers
 * (affiliate — incl. the POST .../affiliates/:id/payouts money-write —,
 * notification, abandoned-cart, recommendation, shipping-carrier) were
 * dual-mounted at '/stores' AND '/public' until this guard landed.
 *
 * This test walks the REAL router table (`@api/routes`, the same one
 * apps/api/src/index.ts mounts at /api/v1) — every mount, every nested
 * router — so a future `router.use('/public', someAdminRouter)` or a '/'
 * mount declaring an admin '/public/...' path goes red, whichever file it is
 * in. `authorize` is wrapped only to TAG the middleware it returns with the
 * roles it was built for; nothing here executes a handler.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const STAFF_ROLES = new Set(['store_admin', 'super_admin', 'staff', 'admin']);
const ADMIN_TAG = Symbol.for('test.adminGuard');

vi.mock('@api/middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/auth')>();
  return {
    ...actual,
    authorize: (...roles: string[]) => {
      const mw = actual.authorize(...roles);
      if (roles.some(r => STAFF_ROLES.has(r))) {
        (mw as unknown as Record<symbol, string[]>)[ADMIN_TAG] = roles;
      }
      return mw;
    },
  };
});

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  handle: { stack?: Layer[] } & ((...args: unknown[]) => unknown);
  regexp: RegExp & { fast_slash?: boolean };
  keys: Array<{ name: string }>;
}

/** Recover an Express 4 mount prefix ('/public', '/stores/:storeId/campaigns', '') from its regexp. */
function mountPrefix(layer: Layer): string {
  if (layer.regexp.fast_slash) return '';
  let src = layer.regexp.source;
  src = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  let i = 0;
  src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys[i++]?.name ?? 'param'}`);
  return src.replace(/\\\//g, '/');
}

interface FoundRoute {
  method: string;
  path: string;
  /** authorize(staff role) / requireStoreAccess — per-route OR inherited. */
  adminGuards: string[];
  /** `authenticate` anywhere in the chain (per-route or router-level). */
  authenticated: boolean;
}

interface Markers {
  requireStoreAccess: unknown;
  authenticate: unknown;
}

/** Guard names a middleware function stands for, if any. */
function guardsOf(handle: unknown, m: Markers): string[] {
  const out: string[] = [];
  const tag = (handle as Record<symbol, string[]> | undefined)?.[ADMIN_TAG];
  if (tag) out.push(`authorize(${tag.join(',')})`);
  if (handle === m.requireStoreAccess) out.push('requireStoreAccess');
  if (handle === m.authenticate) out.push('authenticate');
  return out;
}

interface Inherited {
  prefix: string;
  guard: string;
}

const covers = (mount: string, full: string) =>
  mount === '' || full === mount || full.startsWith(`${mount}/`);

/**
 * Walk an Express 4 router stack. Middleware attached with `router.use(...)`
 * (a non-route, non-router layer) guards every LATER layer under its mount
 * path, so it is threaded down as `inherited` (#2036) — a router whose auth is
 * all router-level must not look unguarded.
 */
function collect(stack: Layer[], prefix: string, m: Markers, inherited: Inherited[] = []) {
  const out: FoundRoute[] = [];
  const scoped: Inherited[] = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const full = prefix + layer.route.path;
      const guards = [
        ...scoped.filter(g => covers(g.prefix, full)).map(g => g.guard),
        ...layer.route.stack.flatMap(h => guardsOf(h.handle, m)),
      ];
      for (const method of Object.keys(layer.route.methods)) {
        out.push({
          method: method.toUpperCase(),
          path: full,
          adminGuards: guards.filter(g => g !== 'authenticate'),
          authenticated: guards.includes('authenticate'),
        });
      }
    } else if (Array.isArray(layer.handle?.stack)) {
      out.push(...collect(layer.handle.stack, prefix + mountPrefix(layer), m, scoped));
    } else {
      for (const guard of guardsOf(layer.handle, m)) {
        scoped.push({ prefix: prefix + mountPrefix(layer), guard });
      }
    }
  }
  return out;
}

let routes: FoundRoute[] = [];
let markers: Markers;

beforeAll(async () => {
  const { default: apiRoutes } = await import('@api/routes');
  const { requireStoreAccess } = await import('@api/middleware/store-access');
  const { authenticate } = await import('@api/middleware/auth');
  markers = { requireStoreAccess, authenticate };
  routes = collect((apiRoutes as unknown as { stack: Layer[] }).stack, '', markers);
}, 60_000);

/**
 * The CSRF skip is `req.path.includes('/public/')` and the platform-origin
 * allowlist admits `^/api/v1/stores/public/…` at any depth, so BOTH controls
 * are off one prefix deeper too: a `'/public/:storeId/…'` route declared on a
 * router mounted at bare `'/stores'` (wallet, shipping, coupons, carrier
 * tracking…) resolves to `/stores/public/…`. The guard covered only the
 * `/public` mount until issue 2121; a future admin route at
 * `'/public/:storeId/payouts'` under `'/stores'` would have re-opened #1993
 * with this suite green.
 */
const PUBLIC_PREFIXES = ['/public', '/stores/public'];
const isPublic = (p: string) => PUBLIC_PREFIXES.some(x => p === x || p.startsWith(`${x}/`));

describe('#1993 — no admin route is reachable under /api/v1/public or /api/v1/stores/public', () => {
  it('the walker actually sees the router table (positive control)', () => {
    // Without this, an empty walk would pass the assertion below vacuously.
    expect(routes.length).toBeGreaterThan(200);
    const payouts = routes.find(
      r => r.method === 'POST' && r.path === '/stores/:storeId/affiliates/:id/payouts'
    );
    expect(payouts, 'admin payout route must still exist under /stores').toBeDefined();
    expect(payouts!.adminGuards).toEqual(
      expect.arrayContaining(['requireStoreAccess', 'authorize(store_admin,super_admin)'])
    );
  });

  it('the walker classifies the /stores/public twin as public too (issue 2121 positive control)', () => {
    const twin = routes.filter(r => r.path.startsWith('/stores/public/') && isPublic(r.path));
    // shipping, coupons, promotions, wallet, carrier tracking… all live here.
    expect(twin.length).toBeGreaterThan(5);
  });

  it('an admin route declared at /public/:storeId/… on a /stores-mounted router is REPORTED (issue 2121)', async () => {
    const { Router } = await import('express');
    const { authenticate, authorize } = await import('@api/middleware/auth');
    const storesRouter = Router();
    storesRouter.post(
      '/public/:storeId/payouts',
      authenticate,
      authorize('store_admin', 'super_admin'),
      markers.requireStoreAccess as never,
      (_req, res) => res.end()
    );
    const api = Router();
    api.use('/stores', storesRouter);
    const found = collect((api as unknown as { stack: Layer[] }).stack, '', markers);
    const leaks = found.filter(r => isPublic(r.path) && r.adminGuards.length > 0);
    expect(leaks.map(r => r.path)).toEqual(['/stores/public/:storeId/payouts']);
  });

  it('no /public route carries authorize(staff role) or requireStoreAccess', () => {
    const leaks = routes
      .filter(r => isPublic(r.path) && r.adminGuards.length > 0)
      .map(r => `${r.method} /api/v1${r.path}  [${r.adminGuards.join(' + ')}]`);
    expect(leaks).toEqual([]);
  });

  it('every storefront /public caller of the split routers still resolves', () => {
    // The storefront (apps/web) calls these at /public; they must stay there,
    // unguarded, after the admin halves were taken off '/public'.
    const expected: Array<[string, string]> = [
      ['GET', '/public/:storeId/affiliates/track'],
      ['POST', '/public/:storeId/affiliates/apply'],
      ['POST', '/public/:storeId/push/subscribe'],
      ['POST', '/public/:storeId/push/unsubscribe'],
      ['GET', '/public/:storeId/products/:productId/recommendations'],
      ['GET', '/public/:storeId/cart/recommendations'],
    ];
    for (const [method, path] of expected) {
      expect(
        routes.some(r => r.method === method && r.path === path),
        `${method} ${path}`
      ).toBe(true);
    }
  });

  it('public affiliate click-tracking is no longer shadowed by the admin GET /:id route', () => {
    // Under the old dual mount, GET /public/:storeId/affiliates/:id (admin)
    // was declared before .../affiliates/track and matched it first, so every
    // storefront click-track 401'd. Order matters: the first /public route
    // matching 'track' must be the public one.
    const first = routes.find(
      r =>
        r.method === 'GET' &&
        isPublic(r.path) &&
        /^\/public\/:storeId\/affiliates\/(track|:id)$/.test(r.path)
    );
    expect(first?.path).toBe('/public/:storeId/affiliates/track');
  });
});

/**
 * #2036 — the walker must see ROUTER-LEVEL auth (`router.use(authenticate,
 * authorize(...), requireStoreAccess)`, the shape ai.routes.ts / admin.routes.ts
 * use), not only per-route handler arrays. Negative control: a router whose
 * only auth is router-level, mounted at '/public', MUST be reported.
 */
describe('#2036 — router-level middleware is visible to the guard', () => {
  it('reports a /public router whose admin auth is applied with router.use', async () => {
    const { Router } = await import('express');
    const { authenticate, authorize } = await import('@api/middleware/auth');
    const inner = Router();
    inner.use(
      authenticate,
      authorize('store_admin', 'super_admin'),
      markers.requireStoreAccess as never
    );
    inner.post('/:storeId/money', (_req, res) => res.end());
    const api = Router();
    api.use('/public', inner);

    const found = collect((api as unknown as { stack: Layer[] }).stack, '', markers);
    const money = found.find(r => r.path === '/public/:storeId/money');
    expect(money?.adminGuards).toEqual(
      expect.arrayContaining(['authorize(store_admin,super_admin)', 'requireStoreAccess'])
    );
    expect(money?.authenticated).toBe(true);
  });

  it('router-level middleware guards only LATER layers under its own mount path', async () => {
    const { Router } = await import('express');
    const { authenticate } = await import('@api/middleware/auth');
    const inner = Router();
    inner.get('/before', (_req, res) => res.end());
    inner.use('/private', authenticate);
    inner.get('/private/x', (_req, res) => res.end());
    inner.get('/other', (_req, res) => res.end());
    const found = collect((inner as unknown as { stack: Layer[] }).stack, '', markers);
    const auth = Object.fromEntries(found.map(r => [r.path, r.authenticated]));
    expect(auth).toEqual({ '/before': false, '/private/x': true, '/other': false });
  });
});

/**
 * A credentialed route under '/public' is outside csrfProtection and
 * restrictPlatformOnlyOrigins whatever its role check, so a CUSTOMER session is
 * the same attack shape as an admin one. Every `authenticate`d '/public' route
 * must be named here with the reason its exposure is accepted.
 */
describe('authenticated /public routes are an explicit, reasoned list', () => {
  const ALLOWED: Record<string, string> = {
    'GET /public/orders':
      'customer reads own orders (read-only; CORS still limits which origins get the body)',
    'GET /public/orders/:id/invoice': 'customer reads own invoice (read-only)',
    'GET /public/customers/me/reorder':
      'customer reads the ids of their own last products for "order again" (read-only, per customer, private no-store; the caller is the only subject, CORS still limits which origins get the body)',
    'GET /public/:storeId/loyalty/my-points': 'customer reads own points (read-only)',
    'GET /public/:storeId/loyalty/my-transactions': 'customer reads own history (read-only)',
    'POST /public/:storeId/loyalty/join':
      'customer opts into the store loyalty programme — idempotent, no money moves, acts only on the caller; accepted residual: a lured shopper can be enrolled',
    // The /stores/public twin (issue 2121) — resolved from '/public/:storeId/…'
    // paths declared on routers mounted at bare '/stores'.
    'GET /stores/public/:storeId/wallet':
      "customer reads own wallet balance (read-only; requireCustomer scopes it to the caller's own customer id)",
    'GET /stores/public/:storeId/wallet/transactions':
      'customer reads own wallet history (read-only; requireCustomer scopes it to the caller; merchant notes/actor stripped)',
    'GET /stores/public/:storeId/orders/:orderId/tracking':
      'read-only tracking; in-handler check confines a customer to their own order and an admin to their own store (#1814)',
  };

  it('no other /public route is authenticated', () => {
    const live = routes
      .filter(r => isPublic(r.path) && r.authenticated)
      .map(r => `${r.method} ${r.path}`);
    expect(live.filter(k => !(k in ALLOWED))).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const live = new Set(
      routes.filter(r => isPublic(r.path) && r.authenticated).map(r => `${r.method} ${r.path}`)
    );
    expect(Object.keys(ALLOWED).filter(k => !live.has(k))).toEqual([]);
  });
});
