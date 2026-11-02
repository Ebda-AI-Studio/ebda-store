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

import { needsLiveIdentity, NON_SENSITIVE_GET, normalisedPath } from '@api/lib/auth-sensitivity';

/** `/stores(?:/([^/]+?))/x/:id` and `/stores/:storeId/x` -> `/stores/x1/x/x2`, with the `/api/v1` mount. */
const concrete = (p: string) =>
  '/api/v1' + p.replace(/\(\?:\/\(\[\^\/\]\+\?\)\)/g, '/x1').replace(/:[A-Za-z]+/g, 'x2');

describe('NZ-D10: authenticated requests are live-checked unless explicitly allowlisted', () => {
  it('every authenticated GET route is live, or its exact path is on the allowlist', () => {
    const gets = routes.filter(
      r => r.method === 'GET' && r.authenticated && !r.path.startsWith('/public')
    );
    expect(gets.length).toBeGreaterThan(200);
    const skipped = gets.filter(
      r => !needsLiveIdentity({ method: 'GET', originalUrl: concrete(r.path) })
    );
    for (const r of skipped) {
      const path = normalisedPath({ originalUrl: concrete(r.path) });
      expect(
        NON_SENSITIVE_GET.some(re => re.test(path)),
        `${r.path} skips the live check but is not allowlisted`
      ).toBe(true);
    }
  });
  it('every allowlist entry matches a real authenticated GET route (no stale entries)', () => {
    const paths = routes
      .filter(r => r.method === 'GET' && r.authenticated)
      .map(r => normalisedPath({ originalUrl: concrete(r.path) }));
    for (const re of NON_SENSITIVE_GET)
      expect(
        paths.some(p => re.test(p)),
        `${re} matches no route`
      ).toBe(true);
  });
  it('every state change is live', () => {
    for (const r of routes.filter(x => x.method !== 'GET' && x.authenticated))
      expect(
        needsLiveIdentity({ method: r.method, originalUrl: concrete(r.path) }),
        `${r.method} ${r.path}`
      ).toBe(true);
  });
  it.each([
    '/api/v1/stores/s1/orders',
    '/api/v1/stores/s1/orders/o1',
    '/api/v1/stores/s1/abandoned-carts',
    '/api/v1/stores/s1/subscribers',
    '/api/v1/stores/s1/loyalty/members',
    '/api/v1/stores/s1/payment-abandonments',
    '/api/v1/stores/s1/agent-credentials',
    '/api/v1/stores/s1/affiliates',
    '/api/v1/stores/s1/expenses',
    '/api/v1/stores/s1/fiscal-documents',
    '/api/v1/stores/s1/merchant-keys',
    '/api/v1/stores/s1/customers.json',
    '/api/v1/stores/s1/typography.json',
    '/api/v1/stores/s1/typography/extra',
    '/api/v1/stores/s1/shipping/area-rates/export.xlsx',
    '/api/v1/brand-new-route-nobody-classified',
  ])('%s is live (deny by default, suffixes never match)', path => {
    expect(needsLiveIdentity({ method: 'GET', originalUrl: path })).toBe(true);
    expect(needsLiveIdentity({ method: 'GET', originalUrl: path + '?format=csv' })).toBe(true);
  });
  it('the allowlisted reads skip the check, with a query string and trailing slash', () => {
    expect(needsLiveIdentity({ method: 'GET', originalUrl: '/api/v1/auth/me?x=1' })).toBe(false);
    expect(needsLiveIdentity({ method: 'GET', originalUrl: '/api/v1/stores/s1/typography/' })).toBe(
      false
    );
    expect(needsLiveIdentity({ method: 'POST', originalUrl: '/api/v1/auth/me' })).toBe(true);
  });
});
