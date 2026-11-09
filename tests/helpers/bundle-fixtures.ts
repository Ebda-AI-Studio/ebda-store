/**
 * Shared fixtures for the product-bundles cart/checkout/storefront test
 * suites (Task 5 cart-bundles, and — per the Task 5 brief — extended rather
 * than duplicated by Task 6 order expansion, Task 7, and Task 8 storefront
 * rendering).
 *
 * Everything here talks to a REAL Postgres database via `@ebda/database`'s
 * `prisma`/`withRlsBypass` — there is no mocked-Prisma path in this file.
 * Callers are responsible for gating their `describe` block on `hasDb`
 * (see `hasDb` below) so the suite skips cleanly when no real database is
 * configured, exactly like `tests/integration/accounting-cross-tenant.test.ts`
 * and `tests/integration/product-search-floor.test.ts`.
 *
 * RULING C6: nothing in this file runs a Prisma migration command or points
 * at a hosted database — it only reads/writes rows through the already-
 * migrated schema via the ordinary Prisma client.
 */
import express, { type Express } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma, withRlsBypass } from '@ebda/database';
import type { BundlePricingType } from '@ebda/shared';
import cartRoutes from '@api/routes/cart.routes';
import bundleRoutes from '@api/routes/bundle.routes';
import returnRoutes from '@api/routes/return.routes';
import { tenantContext } from '@api/middleware/tenant-context';
import { resolveBundle, type ResolvedBundle } from '@api/services/bundle.service';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import { ReturnService } from '@api/services/return.service';
import { errorHandler } from '@api/middleware/error-handler';
import { config } from '@api/config';
import { invalidateStoreProductCaches } from '@api/lib/public-cache';

/** True when a real (non-placeholder) DATABASE_URL is configured. Gate every describe block on this — mirrors the convention already used across tests/integration. */
export const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

/**
 * Builds the minimal Express app these suites need: the real
 * `cart.routes.ts` + `bundle.routes.ts` routers, mounted exactly the way
 * `apps/api/src/routes/index.ts` mounts them in production (cart under
 * `tenantContext` at `/stores/:storeId/cart`; bundles bare at `/stores`,
 * since bundle.routes.ts opens its own `router.param('storeId',
 * tenantContext)`). No `errorHandler` is mounted — same as every other
 * lightweight supertest app in tests/integration/*.test.ts — so a thrown
 * `AppError` still gets its `statusCode` from Express's default error
 * handler (which reads `err.statusCode`/`err.status`), but the BODY is an
 * HTML fallback page, not the JSON envelope. Assert on `res.status` for
 * those; only routes that respond directly with `res.json(...)` (the
 * business-rule 422s) have a JSON body to assert against.
 */
export function buildBundleTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/stores/:storeId/cart', tenantContext, cartRoutes);
  app.use('/api/v1/stores', tenantContext, bundleRoutes);
  return app;
}

/**
 * A cart session id that is unique per CALL, therefore unique per test
 * ATTEMPT.
 *
 * The integration CI job runs with `--retry=1` (vitest.config.ts itself
 * defaults to `retry: 0` since #1248), and a retry re-runs the test BODY
 * against the same database. A session id derived only from a per-file
 * suffix is therefore reused across attempts, so the retry starts against
 * the cart the failed attempt already populated: `addToCart` runs a second
 * time and the assertions see doubled state. That turns every retried
 * failure into a DIFFERENT, misleading error — `expected 4800 to be 2400`,
 * `to have a length of 1 but got 2` — which hides whatever really went
 * wrong on attempt 1. (That is exactly how the original cart-bundles CI
 * failure was mis-read as a pricing bug.)
 *
 * Every cart-owning test must take its session id from here so a retry
 * starts from an empty cart and reports the REAL failure twice, rather
 * than the real failure once and an accumulation artefact after it.
 */
/**
 * A client IP no other test shares, for the `X-Forwarded-For` of requests to the LIVE API (one trusted hop,
 * app.ts). The API budgets writes per IP (`writeLimiter`, Redis) and every file in the tier calls from the same
 * runner address, so a test that places orders can be answered 429 by what other files already spent
 * (order-personalisation-http, run 40234150651). Per-call IP isolates the limiter key; the limit stays as is.
 */
export function uniqueClientIp(): string {
  const b = () => Math.floor(Math.random() * 254) + 1;
  return `10.${b()}.${b()}.${b()}`;
}

let cartSessionSeq = 0;
export function cartSessionId(label: string): string {
  return `session-${label}-${Date.now().toString(36)}-${process.pid}-${++cartSessionSeq}`;
}

export interface FixtureStore {
  storeId: string;
  ownerId: string;
}

/**
 * Seeds a store (with an owner user) and enables the `bundles` feature via
 * a `StoreFeature` override — `bundles` is in NO plan baseline (see
 * `plan-baselines.ts`), so every bundle-selling test needs this or every
 * request 403s with `FEATURE_DISABLED` before reaching the code under test.
 *
 * `suffix` should be a per-test unique string (timestamp+random) so
 * parallel test files never collide on the unique `slug`/`email` columns.
 */
export async function seedBundleStore(suffix: string): Promise<FixtureStore> {
  return withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `bundle-fixture-owner-${suffix}@example.com`,
        passwordHash: 'not-a-real-hash',
        role: 'store_admin',
        firstName: 'Bundle',
        lastName: 'Fixture',
      },
    });

    const store = await tx.store.create({
      data: {
        name: `bundle-fixture-store-${suffix}`,
        slug: `bundle-fixture-${suffix}`,
        template: 'qamar',
        currency: 'EGP',
        ownerId: owner.id,
        status: 'active',
      },
    });

    await tx.storeFeature.create({
      data: { storeId: store.id, featureKey: 'bundles', enabled: true },
    });

    return { storeId: store.id, ownerId: owner.id };
  });
}

/**
 * Seeds a store the SAME way as `seedBundleStore`, but withOUT the
 * `bundles` `StoreFeature` override — `bundles` is in no plan baseline, so
 * this is what every real store looks like today. Used to assert the
 * feature-gate: every bundle route (including the public detail route)
 * must behave for this store exactly as if bundles didn't exist, not
 * merely as if this one bundle didn't exist.
 */
export async function seedStoreWithoutBundlesFeature(suffix: string): Promise<FixtureStore> {
  return withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `bundle-fixture-nofeature-owner-${suffix}@example.com`,
        passwordHash: 'not-a-real-hash',
        role: 'store_admin',
        firstName: 'Bundle',
        lastName: 'NoFeature',
      },
    });

    const store = await tx.store.create({
      data: {
        name: `bundle-fixture-nofeature-store-${suffix}`,
        slug: `bundle-fixture-nofeature-${suffix}`,
        template: 'qamar',
        currency: 'EGP',
        ownerId: owner.id,
        status: 'active',
      },
    });

    return { storeId: store.id, ownerId: owner.id };
  });
}

/** Seeds a real `customer`-role user — for tests that exercise a logged-in customer's cart (e.g. `CartService.mergeGuestCart`), as opposed to the guest-session path `cartClientFor` drives by default. */
export async function seedCustomer(suffix: string): Promise<string> {
  const user = await withRlsBypass(tx =>
    tx.user.create({
      data: {
        email: `bundle-fixture-customer-${suffix}@example.com`,
        passwordHash: 'not-a-real-hash',
        role: 'customer',
        firstName: 'Bundle',
        lastName: 'Customer',
      },
    })
  );
  return user.id;
}

export interface SeedProductOptions {
  name?: string;
  price: number;
  inventory: number;
  trackInventory?: boolean;
}

/** Seeds one active, variant-less product with the given price/stock. */
export async function seedProduct(
  storeId: string,
  suffix: string,
  opts: SeedProductOptions
): Promise<string> {
  const name = opts.name ?? `bundle-fixture-product-${suffix}`;
  const product = await withRlsBypass(tx =>
    tx.product.create({
      data: {
        storeId,
        name,
        slug: `${name}-${Math.random().toString(36).slice(2, 8)}`,
        price: opts.price,
        inventory: opts.inventory,
        trackInventory: opts.trackInventory ?? true,
        status: 'active',
      },
    })
  );
  return product.id;
}

export interface SeedBundleItemInput {
  productId: string;
  variantId?: string;
  quantity: number;
}

export interface SeedBundleOptions {
  name?: string;
  pricingType: BundlePricingType;
  pricingValue: number;
  items: SeedBundleItemInput[];
  isActive?: boolean;
  startsAt?: Date | null;
  expiresAt?: Date | null;
}

/**
 * Seeds a bundle (+ its BundleItem rows) directly, bypassing the admin
 * route's allocatability check — tests that need an allocatable price
 * should pick round numbers (this mirrors how bundle.service's own tests
 * construct fixtures).
 *
 * Busts the same caches the real POST /:storeId/bundles route does
 * (`invalidateStoreProductCaches`, which also clears the bundle list) — this
 * write bypasses that route entirely, so nothing else would. Skipping this
 * is exactly the bug the public-bundle-list cache (#1565) exposed: a store
 * shared across `it()` blocks in the same `describe` (the common pattern in
 * this suite) caches its public bundle list on the FIRST request, and every
 * bundle seeded directly into the DB afterwards — never going through a
 * cache-busting route — stayed invisible until the 120s TTL expired.
 */
export async function seedBundle(
  storeId: string,
  suffix: string,
  opts: SeedBundleOptions
): Promise<string> {
  const name = opts.name ?? `bundle-fixture-bundle-${suffix}`;
  const bundle = await withRlsBypass(tx =>
    tx.bundle.create({
      data: {
        storeId,
        name,
        slug: `${name}-${Math.random().toString(36).slice(2, 8)}`,
        pricingType: opts.pricingType,
        pricingValue: opts.pricingValue,
        isActive: opts.isActive ?? true,
        startsAt: opts.startsAt ?? null,
        expiresAt: opts.expiresAt ?? null,
        items: {
          create: opts.items.map(item => ({
            productId: item.productId,
            variantId: item.variantId ?? null,
            quantity: item.quantity,
          })),
        },
      },
    })
  );
  await invalidateStoreProductCaches(storeId);
  return bundle.id;
}

/**
 * Directly sets a product's `inventory` column (variant-less products only
 * — see docs/architecture/inventory-model.md for the variant case).
 *
 * Busts the product/bundle caches the same way the real stock-write paths
 * now do (InventoryService, stock-adjustment/purchase-order services,
 * barcode-scan) — see the doc comment on `seedBundle` above for why a
 * direct-DB test write needs this too.
 */
export async function setStock(productId: string, inventory: number): Promise<void> {
  const product = await withRlsBypass(tx =>
    tx.product.update({ where: { id: productId }, data: { inventory } })
  );
  await invalidateStoreProductCaches(product.storeId);
}

/** `resolveBundle` against the real `prisma` client — useful for asserting the cross-tenant 404 directly at the service layer, alongside the route-level assertions. */
export async function resolveBundleFor(storeId: string, bundleId: string): Promise<ResolvedBundle> {
  return resolveBundle(prisma, storeId, bundleId);
}

/**
 * Bound HTTP client for one store/session's cart, against the app built by
 * `buildBundleTestApp()`. Every call is a `supertest` request builder — chain
 * `.expect(...)` or `await` it directly and read `.status`/`.body`.
 */
export function cartClientFor(app: Express, storeId: string, sessionId: string) {
  const base = `/api/v1/stores/${storeId}/cart`;
  return {
    getCart: () => request(app).get(base).set('x-session-id', sessionId),
    addToCart: (body: {
      productId: string;
      quantity?: number;
      variantId?: string;
      note?: string;
    }) => request(app).post(`${base}/items`).set('x-session-id', sessionId).send(body),
    removeFromCart: (itemId: string) =>
      request(app).delete(`${base}/items/${itemId}`).set('x-session-id', sessionId),
    addBundleToCart: (body: { bundleId: string; quantity?: number }) =>
      request(app).post(`${base}/bundles`).set('x-session-id', sessionId).send(body),
    removeBundleFromCart: (cartBundleId: string) =>
      request(app).delete(`${base}/bundles/${cartBundleId}`).set('x-session-id', sessionId),
    clearCart: () => request(app).delete(base).set('x-session-id', sessionId),
    /** The public storefront bundle list for this store — no session/auth needed. */
    publicBundles: () =>
      request(app).get(`/api/v1/stores/public/${storeId}/bundles`).set('x-session-id', sessionId),
    /** The public storefront single-bundle detail (by slug) for this store — no session/auth needed. */
    publicBundleDetail: (slug: string) =>
      request(app)
        .get(`/api/v1/stores/public/${storeId}/bundles/${encodeURIComponent(slug)}`)
        .set('x-session-id', sessionId),
  };
}

// ==========================================
// Task 6 additions — order creation expands bundles into component lines
// ==========================================

/** Current `products.inventory` for a variant-less product (see `setStock`). */
export async function stockOf(productId: string): Promise<number> {
  const product = await withRlsBypass(tx =>
    tx.product.findUnique({ where: { id: productId }, select: { inventory: true } })
  );
  return product?.inventory ?? 0;
}

/**
 * A complete, valid `CreateOrderData.shippingAddress` — every field
 * `OrderService.create` reads (area/governorate resolution, phone/email for
 * coupon per-user identity) is present so a checkout test never fails on an
 * unrelated missing field. Callers that need a specific area/governorate for
 * a shipping-zone test should spread over this rather than building their
 * own from scratch.
 */
export const DEFAULT_TEST_SHIPPING_ADDRESS = {
  firstName: 'Bundle',
  lastName: 'Buyer',
  address1: 'Block 1, Street 1',
  city: 'Cairo',
  state: 'Capital',
  area: 'Cairo',
  postalCode: '00000',
  country: 'EG',
  phone: '96551234567',
  email: 'bundle-buyer@example.com',
};

let shippingIdentitySeq = 0;
/**
 * DEFAULT_TEST_SHIPPING_ADDRESS with a phone + email unique to this CALL. The open-hold cap
 * (lib/stock-hold-cap.ts, #65/#75: 5 unpaid gateway orders per phone or email per store) counts
 * every order a file places with the shared fixture identity, so the 6th order in a file was a
 * 429 that had nothing to do with the test. Tests that exercise the cap keep the shared one.
 */
export function testShippingAddress(): typeof DEFAULT_TEST_SHIPPING_ADDRESS {
  const n = ++shippingIdentitySeq;
  return {
    ...DEFAULT_TEST_SHIPPING_ADDRESS,
    phone: `9655${String(process.pid % 1000).padStart(3, '0')}${String(n).padStart(4, '0')}`,
    email: `bundle-buyer-${process.pid}-${n}-${Date.now().toString(36)}@example.com`,
  };
}

/** Adds `productId` (at `quantity`) as an ordinary loose line to `sessionId`'s cart — a thin wrapper over `CartService.addItem` so tests exercising a MIX of loose items and bundles don't need their own import of `CartService`. */
export async function addItemToCart(
  storeId: string,
  sessionId: string,
  productId: string,
  quantity = 1
): Promise<void> {
  await CartService.addItem(storeId, sessionId, productId, quantity);
}

/** Adds `bundleId` (at `quantity`) to `sessionId`'s cart via `CartService.addBundle` — throws if the service refuses (e.g. `bundle_not_purchasable`), since every caller in this file expects the add itself to succeed and is testing something that happens LATER, at checkout. */
export async function addBundleToCart(
  storeId: string,
  sessionId: string,
  bundleId: string,
  quantity = 1
): Promise<void> {
  const result = await CartService.addBundle(storeId, sessionId, bundleId, quantity);
  if (!result.ok) {
    throw new Error(`addBundleToCart: CartService.addBundle refused (${result.error})`);
  }
}

export interface CheckoutOptions {
  sessionId?: string;
  customerId?: string;
  paymentMethod?: string;
  /** Extra loose items to add to the SAME cart before checkout — for the combined-demand tests, which need a bundle and a loose line of the shared product in one order. */
  extraItems?: Array<{ productId: string; quantity?: number }>;
}

/**
 * The full path a real customer takes: a fresh session, `bundleId` added to
 * its cart at `quantity`, then `OrderService.create` called directly —
 * mirrors how `tests/integration/loyalty-redemption.test.ts` drives
 * checkout for other money-path integration coverage (bypassing HTTP, which
 * adds nothing this suite needs to assert). `paymentMethod` defaults to
 * `paymob` (non-COD) so checkout doesn't attempt the COD
 * inngest/socket notification fanout that a lightweight test app doesn't
 * wire up. Returns the created order WITH `items` (already included by
 * `OrderService.create`).
 */
export async function checkoutBundleFor(
  storeId: string,
  bundleId: string,
  quantity = 1,
  opts: CheckoutOptions = {}
) {
  const sessionId =
    opts.sessionId ?? `checkout-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await CartService.getOrCreate(storeId, sessionId, opts.customerId);
  await addBundleToCart(storeId, sessionId, bundleId, quantity);
  for (const extra of opts.extraItems ?? []) {
    await addItemToCart(storeId, sessionId, extra.productId, extra.quantity ?? 1);
  }
  return OrderService.create(storeId, opts.customerId, sessionId, {
    shippingAddress: testShippingAddress(),
    paymentMethod: opts.paymentMethod ?? 'paymob',
  });
}

/** Every distinct `bundleGroupId` present on an order's items, in first-seen order — `groupOf` for a single-box order, `groupsOf` when more than one box/bundle may be present. */
export function groupsOf(order: { items: Array<{ bundleGroupId: string | null }> }): string[] {
  const seen = new Set<string>();
  for (const item of order.items) {
    if (item.bundleGroupId) seen.add(item.bundleGroupId);
  }
  return [...seen];
}

// ==========================================
// Task 7 additions — atomic bundle returns
// ==========================================

/** The single `bundleGroupId` on an order that holds exactly one bundle box — throws if zero or more than one, so a test reaching for the wrong helper fails loudly instead of silently picking `groupsOf(order)[0]`. Multi-box orders should index into `groupsOf` directly. */
export function groupOf(order: { items: Array<{ bundleGroupId: string | null }> }): string {
  const groups = groupsOf(order);
  if (groups.length !== 1) {
    throw new Error(
      `groupOf: expected exactly one bundleGroupId on the order, found ${groups.length}`
    );
  }
  return groups[0];
}

/**
 * Flips an order straight to `delivered` via Prisma, bypassing the real
 * fulfilment lifecycle. `ReturnService.create`'s eligibility gate only
 * accepts a `delivered` order, but `checkoutBundleFor`/`OrderService.create`
 * leave a fresh order `pending` — every return test needs this first.
 */
export async function markOrderDelivered(orderId: string): Promise<void> {
  await withRlsBypass(tx =>
    tx.order.update({ where: { id: orderId }, data: { status: 'delivered' } })
  );
}

export interface CreateBundleReturnOptions {
  /** Bundle boxes to return as complete, atomic units — see `bundleGroupIds` on `ReturnService.create`. */
  bundleGroupIds?: string[];
  /** Individual (non-bundle) order lines to return — an entry naming a line inside a bundle group is refused with `bundle_returns_are_atomic`. */
  items?: Array<{
    orderItemId: string;
    productId: string;
    productName: string;
    quantity: number;
  }>;
  type?: 'return' | 'exchange' | 'refund';
  reason?: string;
}

/**
 * Creates a return request against `order` via `ReturnService.create`
 * directly — bypassing HTTP, the same convention
 * `tests/integration/partial-return-refund-effects.test.ts` uses for this
 * service. Flips the order to `delivered` first (see `markOrderDelivered`)
 * so callers don't have to remember the eligibility gate. `type`/`reason`
 * default to values the bundle-return suites don't care about.
 */
export async function createBundleReturn(
  storeId: string,
  order: { id: string; customerId: string | null },
  opts: CreateBundleReturnOptions
) {
  await markOrderDelivered(order.id);
  if (!order.customerId) {
    throw new Error(
      'createBundleReturn: order has no customerId — checkout with { customerId } set'
    );
  }
  return ReturnService.create(storeId, {
    orderId: order.id,
    customerId: order.customerId,
    type: opts.type ?? 'refund',
    reason: opts.reason ?? 'defective',
    items: opts.items,
    bundleGroupIds: opts.bundleGroupIds,
  });
}

// ==========================================
// Task 7 fix-round-1 additions — route-layer (return.routes.ts) coverage
// ==========================================
//
// The service-level helpers above (`createBundleReturn`) call
// `ReturnService.create` directly, the same convention
// `partial-return-refund-effects.test.ts` uses. That leaves the HTTP layer
// — `return.routes.ts`'s Zod schema and its `authenticate` gate — completely
// unexercised for the new `bundleGroupIds` field, which is exactly the gap
// fix-round-1 (Finding 1) named: the route's schema didn't know the field
// existed. These helpers build a real, authenticated HTTP path to it.

/**
 * Builds the minimal Express app for `return.routes.ts`, mounted exactly the
 * way `apps/api/src/routes/index.ts` mounts it in production
 * (`/stores/:storeId/returns` under `tenantContext`).
 *
 * Unlike `buildBundleTestApp()` above, this DOES mount the real
 * `errorHandler` — the new route-layer tests need to assert on the actual
 * JSON error body (`error.code === 'bundle_returns_are_atomic'`, Zod's
 * `VALIDATION_ERROR`), not just the HTTP status code Express's default HTML
 * error page would carry.
 */
export function buildReturnTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/stores/:storeId/returns', tenantContext, returnRoutes);
  app.use(errorHandler);
  return app;
}

/**
 * A real access-token JWT for `userId`, shaped exactly like login/refresh
 * mint one (`role: 'customer'`, `tv: 0`, `ebda-api`/`ebda-app`
 * issuer/audience) — see `tests/unit/csrf-merchant-origin.test.ts`'s
 * `accessCookieFor` for the same pattern. `authenticate` only checks the
 * token's own claims plus the DB's `tokenVersion` for this `userId` (a
 * freshly-seeded customer is `0`, matching `tv: 0` here) — the token's
 * `email` claim need not match the DB row.
 */
export function customerAccessTokenFor(userId: string, storeId?: string): string {
  // A customer token is bound to the store it was issued for (F-01, Ruling S11-1);
  // `authenticate` rejects one without it. Pass the store the customer belongs to.
  return jwt.sign(
    { userId, email: `${userId}@example.test`, role: 'customer', tv: 0, storeId },
    config.jwtSecret,
    { expiresIn: '30m', issuer: 'ebda-api', audience: 'ebda-app' }
  );
}

/** Bound HTTP client for one customer's returns, against `buildReturnTestApp()`. */
export function returnsClientFor(app: Express, storeId: string, customerId: string) {
  const token = customerAccessTokenFor(customerId, storeId);
  const base = `/api/v1/stores/${storeId}/returns`;
  return {
    create: (body: unknown) =>
      request(app).post(base).set('Authorization', `Bearer ${token}`).send(body),
  };
}

/**
 * A real access-token JWT for a `store_admin`, shaped like
 * `customerAccessTokenFor` above but with the role `bundle.routes.ts`'s
 * `adminMiddleware` (`authorize('store_admin', 'super_admin')`) requires. A
 * freshly-seeded owner's `tokenVersion` is `0`, matching `tv: 0` here —
 * pass the STORE'S `ownerId` (`seedBundleStore`'s `FixtureStore.ownerId`),
 * since `requireStoreAccess` checks `store_admin` against `store.ownerId`.
 */
export function storeAdminAccessTokenFor(userId: string): string {
  return jwt.sign(
    { userId, email: `${userId}@example.test`, role: 'store_admin', tv: 0 },
    config.jwtSecret,
    { expiresIn: '30m', issuer: 'ebda-api', audience: 'ebda-app' }
  );
}

/**
 * Bound HTTP client for a store's admin bundle CRUD, against
 * `buildBundleTestApp()` — exercises the REAL POST/PUT `/:storeId/bundles`
 * routes (including their cache-invalidation calls), unlike `seedBundle`
 * above which writes directly to the DB.
 */
export function adminBundleClientFor(app: Express, store: FixtureStore) {
  const token = storeAdminAccessTokenFor(store.ownerId);
  const base = `/api/v1/stores/${store.storeId}/bundles`;
  return {
    create: (body: unknown) =>
      request(app).post(base).set('Authorization', `Bearer ${token}`).send(body),
    update: (id: string, body: unknown) =>
      request(app).put(`${base}/${id}`).set('Authorization', `Bearer ${token}`).send(body),
  };
}
