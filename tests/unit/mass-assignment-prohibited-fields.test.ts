/**
 * B4b — the "parametrised prohibited-field mass-assignment test" left open by
 * an earlier session (`handoff.md`, agent-key-admin-ui branch: "Not carried
 * here … the parametrised prohibited-field mass-assignment test").
 *
 * Scope, derived from the task spec + a full read of every write route:
 *
 *   1. A completeness GUARD (`describe('route inventory coverage')` below)
 *      statically parses store.routes.ts / product.routes.ts / order.routes.ts
 *      — THOSE THREE FILES ONLY — for every `router.post/put/patch/delete(...)`
 *      registration and asserts each one is classified in `ROUTE_INVENTORY` —
 *      either `tested` (exercised by the parametrised cases here) or `exempt`
 *      with a REASON grounded in reading that route's actual body-handling
 *      code. A new write route in one of those three files that isn't added to
 *      this table fails the guard, and so does a registration whose path is not
 *      a string literal (it would otherwise be invisible to the parser).
 *
 *      WHAT THIS DOES NOT COVER (#1950/#1968 — do not read it as repo-wide):
 *      the other ~60 route files that register write routes (payment,
 *      payment-links, return, finance, loyalty, wallet, cart, staff,
 *      customers, purchase-orders, …) have NO per-route classification here.
 *      For them the only repo-wide gate is the static one in
 *      `describe('repo-wide mass-assignment shape gate')` below: no route file
 *      may `.passthrough()` a schema (outside an allowlisted, reasoned JSON
 *      blob) or hand `req.body` to a write unparsed. The service layer is
 *      proven to enumerate its Prisma `data` only for `StoreService.update`
 *      (tests/unit/mass-assignment-service-data-shape.test.ts); every other
 *      service rests on the manual read described below.
 *
 *   2. Parametrised HTTP-level cases (`it.each` below, supertest + a mocked
 *      `*Service` layer per router — mirrors `tests/unit/order-refund-route
 *      .test.ts`'s app-bootstrap pattern) for the 8 routes where a body maps
 *      most directly onto a Prisma row: store create/update/status,
 *      product create/update, and order checkout-create/admin-create/status.
 *      Each sends prohibited fields (id, storeId, ownerId, createdAt,
 *      updatedAt, deletedAt, agentApiKey, and for
 *      store also plan + status) alongside a valid body and asserts none of
 *      them reach the mocked service call that performs the write.
 *
 * Why "reaches the service" is the right boundary to assert here (not "reaches
 * Prisma" via a live DB): every one of these routes validates `req.body`
 * through a Zod `z.object(...)` schema BEFORE calling its service (Zod's
 * default "strip" mode silently drops unrecognised keys — none of these
 * schemas declare `id`/`storeId`/`ownerId`/`createdAt`/`updatedAt`/`deletedAt`
 * /`agentApiKey`, and the store schema also
 * never declares `plan`/`status`), and a manual read of `StoreService.update`,
 * `ProductService.create`/`update` and `OrderService.createAdminOrder`/
 * `OrderService.create` confirms the service layer itself enumerates each
 * Prisma `data` field by name rather than spreading the validated object —
 * so a field that never reaches the service call can never reach Prisma
 * either. Mocking the service and asserting on ITS call arguments proves the
 * route half without standing up a live Postgres, and fails loudly the moment
 * a schema gains `.passthrough()`. It does NOT observe a service spreading
 * `...data` into `prisma.x.update` — the service is mocked here — which is
 * why that half has its own unmocked test (see above).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── Shared mocks (every router file below imports these) ─────────────────

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
  customerUserId: (_req: any) => 'customer-1',
}));

vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/rbac', () => ({
  requirePermission:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

const auditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('@api/middleware/security', () => ({
  auditLog: (...a: unknown[]) => auditLog(...a),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/utils/store-helpers', () => ({
  getAuthUser: (req: any) => req.user,
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const prismaStub = {
  store: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  trustRequest: { create: vi.fn().mockResolvedValue({}), updateMany: vi.fn() },
  storeFaq: { findMany: vi.fn(), create: vi.fn() },
  storeHowto: { findMany: vi.fn(), create: vi.fn() },
  product: { findMany: vi.fn(), findFirst: vi.fn() },
  productFaq: { findMany: vi.fn() },
  order: { findFirst: vi.fn(), findMany: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
};
vi.mock('@ebda/database', () => ({
  prisma: prismaStub,
  Prisma: { DbNull: null },
  StoreStatus: { active: 'active', suspended: 'suspended' },
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withStore: (_s: string, fn: any) => fn(prismaStub),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withUser: (_u: string, fn: any) => fn(prismaStub),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asPlatformOperator: (_u: string, fn: any) => fn(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenantContext: (_req: any, _res: any, next: any) => next(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storeScopeContext: (_req: any, _res: any, next: any) => next(),
}));

// ─── store.routes.ts peripheral mocks ───────────────────────────────────────

const storeServiceCreate = vi.fn();
const storeServiceUpdate = vi.fn();
const storeServiceSetStatus = vi.fn();
vi.mock('@api/services/store.service', () => ({
  StoreService: {
    create: (...a: unknown[]) => storeServiceCreate(...a),
    update: (...a: unknown[]) => storeServiceUpdate(...a),
    setStatus: (...a: unknown[]) => storeServiceSetStatus(...a),
    getById: vi.fn().mockResolvedValue({ id: 'store-1', slug: 'test-store', socialLinks: {} }),
  },
}));

// The per-account daily store cap (SP5 task 4) is covered in self-serve-abuse.test.ts.
vi.mock('@api/services/store-creation-limit', () => ({
  assertStoreCreationBudget: vi.fn().mockResolvedValue(undefined),
  withStoreCreationLock: (_owner: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/domain-provider', () => ({
  resolveDomainService: vi.fn(() => ({ isConfigured: () => false })),
}));
vi.mock('@api/services/store-mailer.service', () => ({
  StoreMailer: {
    provisionStoreDomain: vi.fn(),
    verifyAndRefreshDomain: vi.fn(),
    refreshDomainStatus: vi.fn(),
    removeStoreDomain: vi.fn(),
  },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { invalidateCache: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@api/lib/cors-cache', () => ({ bustCorsCache: vi.fn() }));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  invalidateStoreProductCaches: vi.fn(),
  invalidateCustomersCache: vi.fn(),
}));
vi.mock('@api/lib/marketing-pixels-secrets', () => ({
  maskMarketingPixelSecrets: (v: unknown) => v,
  preserveMaskedPixelSecrets: (v: unknown) => v,
}));
vi.mock('@api/config', () => ({ config: { cfFallbackOrigin: 'fallback.example.com' } }));

// ─── product.routes.ts peripheral mocks ─────────────────────────────────────

const productServiceCreate = vi.fn();
const productServiceUpdate = vi.fn();
vi.mock('@api/services/product.service', () => ({
  ProductService: {
    create: (...a: unknown[]) => productServiceCreate(...a),
    update: (...a: unknown[]) => productServiceUpdate(...a),
    getById: vi.fn(),
    delete: vi.fn(),
    bulkUpdate: vi.fn(),
  },
}));
vi.mock('@api/lib/ai/product-excerpt-generator', () => ({ EXCERPT_MAX_LENGTH: 300 }));

// ─── order.routes.ts peripheral mocks ───────────────────────────────────────

const orderServiceCreate = vi.fn();
const orderServiceCreateAdminOrder = vi.fn();
const orderServiceUpdateStatus = vi.fn();
const orderServiceGetById = vi.fn();
vi.mock('@api/services/order.service', () => ({
  OrderService: {
    create: (...a: unknown[]) => orderServiceCreate(...a),
    createAdminOrder: (...a: unknown[]) => orderServiceCreateAdminOrder(...a),
    updateStatus: (...a: unknown[]) => orderServiceUpdateStatus(...a),
    getById: (...a: unknown[]) => orderServiceGetById(...a),
  },
  assertValidTransition: vi.fn(),
}));
vi.mock('@api/services/invoice.service', () => ({ InvoiceService: {} }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({ PaymentService: {} }));
vi.mock('@api/services/payment-event.service', () => ({ recordPaymentEvent: vi.fn() }));
vi.mock('@api/services/payment-confirm.service', () => ({
  confirmPaymentFromProviderStatus: vi.fn(),
}));
vi.mock('@api/lib/payment-line-items', () => ({ buildPaymentLineItems: vi.fn() }));
vi.mock('@api/services/payment-providers/refund-settlement', () => ({
  resolveRefundSettlement: vi.fn(),
  readAccountedRefundEventIds: vi.fn(),
  appendRefundEventId: vi.fn(),
  recordRefundStatus: vi.fn(),
  REFUND_EVENT_IDS_KEY: 'refund-event-ids',
  REFUND_STATUS_BY_ID_KEY: 'refund-status-by-id',
}));
vi.mock('exceljs', () => ({ default: class {} }));
vi.mock('@api/lib/exports/xlsx', () => ({ neutralizeRowObject: vi.fn() }));

// ─── App bootstrap (mirrors order-refund-route.test.ts) ────────────────────

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '22222222-2222-2222-2222-222222222222';

let storeApp: Express;
let productApp: Express;
let orderApp: Express;

async function buildApp(routerImportPath: string, mountPath: string): Promise<Express> {
  const { default: router } = await import(routerImportPath);
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use(mountPath, router);
  server.use(errorHandler);
  return server;
}

// ─── Prohibited-field payload ───────────────────────────────────────────────

const BASE_PROHIBITED: Record<string, unknown> = {
  id: 'attacker-supplied-id',
  storeId: 'attacker-supplied-store-id',
  ownerId: 'attacker-supplied-owner-id',
  createdAt: '1999-01-01T00:00:00.000Z',
  updatedAt: '1999-01-01T00:00:00.000Z',
  deletedAt: '1999-01-01T00:00:00.000Z',
  agentApiKey: 'attacker-agent-key',
};
const STORE_PROHIBITED: Record<string, unknown> = {
  ...BASE_PROHIBITED,
  plan: 'enterprise',
  status: 'suspended',
};

function assertNoProhibitedFields(captured: unknown, prohibited: Record<string, unknown>) {
  expect(captured).toBeTruthy();
  expect(typeof captured).toBe('object');
  const obj = captured as Record<string, unknown>;
  const leaked = Object.keys(prohibited).filter(k => Object.prototype.hasOwnProperty.call(obj, k));
  expect(leaked).toEqual([]);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('mass assignment — prohibited fields never reach the write-service call', () => {
  it('POST /stores (create) strips id/storeId/ownerId/timestamps/secrets/plan/status', async () => {
    storeApp = await buildApp('@api/routes/store.routes', '/api/v1/stores');
    storeServiceCreate.mockResolvedValue({ id: 'new-store-id' });

    const res = await request(storeApp)
      .post('/api/v1/stores')
      .send({ name: 'Attacker Store', ...STORE_PROHIBITED });

    expect(res.status).toBe(201);
    expect(storeServiceCreate).toHaveBeenCalledTimes(1);
    // arg 0 is the authenticated user's id (never attacker-controlled), arg 1
    // is the create payload under test.
    assertNoProhibitedFields(storeServiceCreate.mock.calls[0][1], STORE_PROHIBITED);
  });

  it('PUT /stores/:id (update) strips id/storeId/ownerId/timestamps/secrets/plan/status', async () => {
    storeApp = await buildApp('@api/routes/store.routes', '/api/v1/stores');
    storeServiceUpdate.mockResolvedValue({ id: STORE_ID });

    const res = await request(storeApp)
      .put(`/api/v1/stores/${STORE_ID}`)
      .send({ name: 'Renamed Store', ...STORE_PROHIBITED });

    expect(res.status).toBe(200);
    expect(storeServiceUpdate).toHaveBeenCalledTimes(1);
    assertNoProhibitedFields(storeServiceUpdate.mock.calls[0][1], STORE_PROHIBITED);
  });

  it('PATCH /stores/:id/status only ever sets status from a validated enum, and ignores a body-supplied id/storeId/ownerId', async () => {
    storeApp = await buildApp('@api/routes/store.routes', '/api/v1/stores');
    storeServiceSetStatus.mockResolvedValue({ id: STORE_ID, status: 'suspended' });
    prismaStub.store.findUnique.mockResolvedValue({ status: 'active' });

    const res = await request(storeApp)
      .patch(`/api/v1/stores/${STORE_ID}/status`)
      .send({ status: 'suspended', ...BASE_PROHIBITED });

    expect(res.status).toBe(200);
    expect(storeServiceSetStatus).toHaveBeenCalledTimes(1);
    // The route reads `req.params.id`, never a body-supplied id/storeId — the
    // ONLY two args the service ever sees are the URL param and the
    // enum-validated status string, so there is no object a prohibited field
    // could ride in on.
    expect(storeServiceSetStatus).toHaveBeenCalledWith(STORE_ID, 'suspended');
  });

  it('POST /stores/:storeId/products (create) strips id/storeId/ownerId/timestamps/secrets', async () => {
    productApp = await buildApp('@api/routes/product.routes', '/api/v1/stores/:storeId/products');
    productServiceCreate.mockResolvedValue({ id: 'new-product-id' });

    const res = await request(productApp)
      .post(`/api/v1/stores/${STORE_ID}/products`)
      .send({ name: 'Attacker Product', price: 1000, ...BASE_PROHIBITED });

    expect(res.status).toBe(201);
    expect(productServiceCreate).toHaveBeenCalledTimes(1);
    assertNoProhibitedFields(productServiceCreate.mock.calls[0][1], BASE_PROHIBITED);
  });

  it('PUT /stores/:storeId/products/:id (update) strips id/storeId/ownerId/timestamps/secrets', async () => {
    productApp = await buildApp('@api/routes/product.routes', '/api/v1/stores/:storeId/products');
    const productId = '33333333-3333-3333-3333-333333333333';
    productServiceUpdate.mockResolvedValue({ id: productId });

    const res = await request(productApp)
      .put(`/api/v1/stores/${STORE_ID}/products/${productId}`)
      .send({ name: 'Renamed Product', ...BASE_PROHIBITED });

    expect(res.status).toBe(200);
    expect(productServiceUpdate).toHaveBeenCalledTimes(1);
    assertNoProhibitedFields(productServiceUpdate.mock.calls[0][2], BASE_PROHIBITED);
  });

  it('POST /stores/:storeId/orders (customer checkout create) strips id/storeId/ownerId/timestamps/secrets', async () => {
    orderApp = await buildApp('@api/routes/order.routes', '/api/v1/stores/:storeId/orders');
    orderServiceCreate.mockResolvedValue({ id: 'new-order-id' });

    const res = await request(orderApp)
      .post(`/api/v1/stores/${STORE_ID}/orders`)
      .set('x-session-id', 'session-1')
      .send({
        shippingAddress: { firstName: 'A', lastName: 'B', address1: 'Street 1', country: 'EG' },
        paymentMethod: 'cod',
        ...BASE_PROHIBITED,
      });

    expect(res.status).toBe(201);
    expect(orderServiceCreate).toHaveBeenCalledTimes(1);
    // OrderService.create(storeId, customerId, sessionId, data, referralCode)
    assertNoProhibitedFields(orderServiceCreate.mock.calls[0][3], BASE_PROHIBITED);
  });

  it('POST /stores/:storeId/orders/admin (admin-created order) strips id/storeId/ownerId/timestamps/secrets', async () => {
    orderApp = await buildApp('@api/routes/order.routes', '/api/v1/stores/:storeId/orders');
    orderServiceCreateAdminOrder.mockResolvedValue({ id: 'new-admin-order-id' });

    const res = await request(orderApp)
      .post(`/api/v1/stores/${STORE_ID}/orders/admin`)
      .send({
        shippingAddress: { line1: 'Street 1' },
        items: [{ productId: '44444444-4444-4444-4444-444444444444', quantity: 1 }],
        ...BASE_PROHIBITED,
      });

    expect(res.status).toBe(200);
    expect(orderServiceCreateAdminOrder).toHaveBeenCalledTimes(1);
    // OrderService.createAdminOrder(storeId, userId, data)
    assertNoProhibitedFields(orderServiceCreateAdminOrder.mock.calls[0][2], BASE_PROHIBITED);
  });

  it('PUT /stores/:storeId/orders/:id/status only ever forwards the URL storeId/id + a validated status enum, never a body-supplied id/storeId', async () => {
    orderApp = await buildApp('@api/routes/order.routes', '/api/v1/stores/:storeId/orders');
    orderServiceGetById.mockResolvedValue({ status: 'pending' });
    orderServiceUpdateStatus.mockResolvedValue({ id: ORDER_ID, status: 'confirmed' });

    const res = await request(orderApp)
      .put(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/status`)
      .send({ status: 'confirmed', ...BASE_PROHIBITED });

    expect(res.status).toBe(200);
    expect(orderServiceUpdateStatus).toHaveBeenCalledTimes(1);
    // Positional args only — storeId/id come from req.params, never from a
    // body that could carry a spoofed id/storeId.
    expect(orderServiceUpdateStatus).toHaveBeenCalledWith(STORE_ID, ORDER_ID, 'confirmed');
  });
});

// ─── Completeness guard ─────────────────────────────────────────────────────

/**
 * Every write route this repo's store/product/order routers expose,
 * classified so a new one can't silently ship uncovered. `tested` routes are
 * exercised above; every `exempt` entry names the concrete code (schema shape
 * or hand-written field list) that makes mass assignment structurally
 * impossible for that route, verified by reading the route source at the time
 * this test was written (2026-09-25).
 */
type Coverage = { tested: true } | { exempt: string };

const ROUTE_INVENTORY: Record<string, Coverage> = {
  // store.routes.ts
  "store.routes.ts POST '/'": { tested: true },
  "store.routes.ts PUT '/:id'": { tested: true },
  "store.routes.ts PATCH '/:id/status'": { tested: true },
  "store.routes.ts POST '/:id/suspension/appeal/reject'": {
    exempt: 'reads no body at all; only the URL store id is used',
  },
  "store.routes.ts PUT '/:id/template'": {
    exempt: 'destructures only `{ template }` from the body; every other key is ignored',
  },
  "store.routes.ts PUT '/:id/look'": {
    exempt:
      '`lookBody` is a `.strict()` `{ lookId, design }` schema; the handler passes only those two values to StoreService.applyLook, which writes `look`/`template` from the registry look, never from the body',
  },
  "store.routes.ts POST '/:id/look/preview'": {
    exempt:
      'a read-only preview: `lookPreviewBody` is a `.strict()` `{ lookId, design }` schema and nothing is written',
  },
  "store.routes.ts PUT '/:id/theme'": {
    exempt:
      'themeSchema is a validated record written ONLY into the `theme` JSON column (StoreService.updateTheme) — no top-level Prisma column is reachable from it',
  },
  "store.routes.ts PUT '/:id/branding'": {
    exempt:
      'brandingSchema uses `.strip()` with a narrow named allowlist (no prohibited field names)',
  },
  "store.routes.ts PUT '/:id/branding-bundle'": {
    exempt:
      '`brandingBundleSchema` is `.strict()` and each part is parsed by the same schema as its own route (brandingSchema, themeSchema, contactSchema, socialSchema); `settings` goes through updateStoreSchema (reserved keys refused or stripped) and the service merge',
  },
  "store.routes.ts PUT '/:id/social'": {
    exempt:
      '`.strip()` schema AND the handler iterates `Object.keys(socialSchema.shape)` explicitly (own anti-prototype-pollution allowlist) before touching the socialLinks JSON',
  },
  "store.routes.ts PUT '/:id/contact'": {
    exempt: 'contactSchema uses `.strip()` with a narrow named allowlist',
  },
  "store.routes.ts PUT '/:id/announcement'": {
    exempt: 'announcementSchema uses `.strip()` with a narrow named allowlist',
  },
  "store.routes.ts PUT '/:id/floating-widget'": {
    exempt: 'floatingWidgetSchema + nested floatingButtonSchema both use `.strip()`',
  },
  "store.routes.ts PUT '/:id/seo'": {
    exempt: 'seoSchema uses `.strip()` with a narrow named allowlist',
  },
  "store.routes.ts PUT '/:id/marketing-pixels'": {
    exempt:
      'marketingPixelsSchema is a validated record written ONLY into the `marketingPixels` JSON column (StoreService.updateMarketingPixels)',
  },
  "store.routes.ts PUT '/:id/domain'": {
    exempt: 'destructures only `{ domain }` (a single string) from the body',
  },
  "store.routes.ts POST '/:id/email-sender/provision'": {
    exempt: 'reads no request body at all — id comes from the URL param',
  },
  "store.routes.ts POST '/:id/email-sender/verify'": {
    exempt: 'reads no request body at all — id comes from the URL param',
  },
  "store.routes.ts POST '/:id/faqs'": {
    exempt: 'faqSchema narrow allowlist; storeId is `req.params.id`, never from the body',
  },
  "store.routes.ts PUT '/:id/faqs/:faqId'": {
    exempt:
      'faqSchema.partial() narrow allowlist; Prisma `data` is built field-by-field, never spread',
  },
  "store.routes.ts POST '/:id/howtos'": {
    exempt: 'howtoSchema narrow allowlist; storeId is `req.params.id`, never from the body',
  },
  "store.routes.ts PUT '/:id/howtos/:howtoId'": {
    exempt:
      'howtoSchema.partial() narrow allowlist; `updateData` is built field-by-field, never spread',
  },
  "store.routes.ts DELETE '/:id'": {
    exempt: 'reads no request body — deletes the store named by the URL param',
  },
  "store.routes.ts DELETE '/:id/faqs/:faqId'": {
    exempt: 'reads no request body — ids come from the URL params',
  },
  "store.routes.ts DELETE '/:id/howtos/:howtoId'": {
    exempt: 'reads no request body — ids come from the URL params',
  },
  // product.routes.ts
  "product.routes.ts DELETE '/:id'": {
    exempt: 'reads no request body — storeId/id come from the URL params',
  },
  "product.routes.ts DELETE '/:id/faqs/:faqId'": {
    exempt: 'reads no request body — ids come from the URL params',
  },
  "product.routes.ts PUT '/new-arrivals/reorder'": {
    exempt:
      'reorderCarouselSchema is `{ orderedProductIds: string[] }` only — no entity fields at all',
  },
  "product.routes.ts PUT '/best-sellers/reorder'": {
    exempt:
      'reorderCarouselSchema is `{ orderedProductIds: string[] }` only — no entity fields at all',
  },
  "product.routes.ts POST '/bulk-set-backorder'": {
    exempt:
      'body is `{ productIds, ... }` scoped to one named boolean column, storeId from the URL param',
  },
  "product.routes.ts POST '/bulk-set-low-stock-threshold'": {
    exempt: 'body is `{ productIds, lowStockThreshold }`, storeId from the URL param',
  },
  "product.routes.ts POST '/bulk-update'": {
    exempt:
      'bulkUpdateSchema.fields is a `.strip()`-default z.object with a narrow named allowlist (status/addCategoryId/isFeatured/isNew/isBestSeller/price/inventory) — none of the prohibited fields',
  },
  "product.routes.ts POST '/'": { tested: true },
  "product.routes.ts PUT '/:id'": { tested: true },
  "product.routes.ts POST '/:id/faqs'": {
    exempt: 'productFaqSchema narrow allowlist; productId is `req.params.id`, never from the body',
  },
  "product.routes.ts PUT '/:id/faqs/:faqId'": {
    exempt: 'productFaqSchema.partial() narrow allowlist; Prisma `data` built field-by-field',
  },
  // order.routes.ts
  "order.routes.ts POST '/'": { tested: true },
  "order.routes.ts PUT '/:id/status'": { tested: true },
  "order.routes.ts POST '/:orderId/invoice/email'": {
    exempt: 'no request-body fields are read at all — queues an email for the existing order',
  },
  "order.routes.ts POST '/:orderId/mark-paid'": {
    exempt: 'reads no request body — orderId/storeId come from the URL params',
  },
  "order.routes.ts POST '/:orderId/confirm-instapay'": {
    exempt: 'reads no request body — orderId/storeId come from the URL params',
  },
  "order.routes.ts POST '/:orderId/instapay-receipts/:receiptId/reject'": {
    exempt: 'body schema is `{ note }` (strict) only; order/receipt ids from the URL params',
  },
  "order.routes.ts POST '/:orderId/instapay-refund'": {
    exempt:
      'instapayRefundRecordSchema (strict): reference/date/recipient/amount/note only; ids from the URL params',
  },
  "order.routes.ts POST '/bulk-mark-paid'": {
    exempt: 'body is `{ orderIds: string[] }` only, validated inline; storeId from the URL param',
  },
  "order.routes.ts POST '/:orderId/refresh-payment-status'": {
    exempt: 'reads no request body — re-checks the existing order/payment against the provider',
  },
  "order.routes.ts POST '/:orderId/refresh-refund-status'": {
    exempt: 'reads no request body — re-checks the existing refund against the provider',
  },
  "order.routes.ts POST '/:orderId/refund-match-claim'": {
    exempt:
      'strict zod body `{ claimId, providerRefundId }` only; storeId/orderId from the URL; needs orders:refund',
  },
  "order.routes.ts POST '/:orderId/partial-refund'": {
    exempt:
      'strict zod body `{ items: [{ orderItemId, quantity, restock? }], reason, refundMethod }` only; storeId/orderId from the URL; needs orders:refund',
  },
  "order.routes.ts POST '/:orderId/refund-via-provider'": {
    exempt: 'body schema is `{ amount?, reason? }` only — no entity identity fields',
  },
  "order.routes.ts POST '/admin'": { tested: true },
  "order.routes.ts POST '/:orderId/payment-link'": {
    exempt: 'body schema is `{ notifyVia }` (one enum) only',
  },
};

const ROUTES_DIR = path.resolve(__dirname, '../../apps/api/src/routes');

function extractWriteRoutes(fileName: string): Array<{ method: string; routePath: string }> {
  const source = readFileSync(path.join(ROUTES_DIR, fileName), 'utf8');
  const pattern = /router\.(post|put|patch|delete)\(\s*['"]([^'"]*)['"]/g;
  const routes: Array<{ method: string; routePath: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    routes.push({ method: match[1].toUpperCase(), routePath: match[2] });
  }
  // A registration whose path is a constant, template literal or
  // `router.route(...)` chain is invisible to the literal pattern above. Count
  // EVERY write registration and fail when the two disagree, instead of
  // silently skipping the one the parser could not read (#1968).
  const all = source.match(/router\.(post|put|patch|delete)\(|router\.route\(/g) ?? [];
  if (all.length !== routes.length) {
    throw new Error(
      `${fileName}: ${all.length} write registrations but only ${routes.length} have a literal path — ` +
        'classify the non-literal one(s) by hand and make the path a literal'
    );
  }
  return routes;
}

describe('route inventory coverage — every store/product/order write route is classified (these 3 files only)', () => {
  const files = ['store.routes.ts', 'product.routes.ts', 'order.routes.ts'];

  it.each(files)('every POST/PUT/PATCH route in %s is in ROUTE_INVENTORY', fileName => {
    const routes = extractWriteRoutes(fileName);
    // A file with zero extracted routes means the regex broke (route syntax
    // changed) — fail loudly rather than silently passing on nothing.
    expect(routes.length).toBeGreaterThan(0);

    const missing = routes
      .map(r => `${fileName} ${r.method} '${r.routePath}'`)
      .filter(key => !(key in ROUTE_INVENTORY));

    expect(missing).toEqual([]);
  });

  it('ROUTE_INVENTORY has no stale entries for routes that no longer exist', () => {
    const liveKeys = new Set<string>();
    for (const fileName of files) {
      for (const r of extractWriteRoutes(fileName)) {
        liveKeys.add(`${fileName} ${r.method} '${r.routePath}'`);
      }
    }
    const stale = Object.keys(ROUTE_INVENTORY).filter(k => !liveKeys.has(k));
    expect(stale).toEqual([]);
  });
});

/**
 * The repo-wide half (#1950/#1968). No per-route classification — that exists
 * only for the three files above — but two shapes are banned in EVERY route
 * file, because either one makes Zod's default strip mode (the thing the whole
 * argument above rests on) stop protecting a write:
 *   - `.passthrough()` on a schema, which forwards unknown keys;
 *   - `req.body` handed to a write without a parse (`data: req.body`,
 *     `...req.body`).
 */
describe('repo-wide mass-assignment shape gate', () => {
  // file -> reason. A passthrough here is on a nested JSON config blob stored
  // in a Json column, never on an object whose keys become Prisma columns.
  // (The page-layout schema's `extraCarousels` passthrough moved out of
  // `store-layout.routes.ts` into `packages/shared/src/builder/layout-schema.ts`
  // with the visual builder registry — still a nested entry of the
  // `layout_settings` JSON column, never mapped onto Store columns.)
  const PASSTHROUGH_ALLOWED: Record<string, string> = {};

  const routeFiles = readdirSync(ROUTES_DIR).filter(f => f.endsWith('.routes.ts'));
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('sees the route files (positive control)', () => {
    expect(routeFiles.length).toBeGreaterThan(50);
  });

  it('no route file uses .passthrough() outside the reasoned allowlist', () => {
    const offenders = routeFiles.filter(
      f =>
        !(f in PASSTHROUGH_ALLOWED) &&
        /\.passthrough\(\)/.test(stripComments(readFileSync(path.join(ROUTES_DIR, f), 'utf8')))
    );
    expect(offenders).toEqual([]);
  });

  it('the passthrough allowlist has no stale entries', () => {
    for (const f of Object.keys(PASSTHROUGH_ALLOWED)) {
      expect(
        /\.passthrough\(\)/.test(stripComments(readFileSync(path.join(ROUTES_DIR, f), 'utf8'))),
        `${f} no longer uses .passthrough() — drop it from the allowlist`
      ).toBe(true);
    }
  });

  it('no route file hands req.body to a write unparsed', () => {
    const offenders = routeFiles.filter(f =>
      /data:\s*req\.body\b|\.\.\.req\.body\b/.test(
        stripComments(readFileSync(path.join(ROUTES_DIR, f), 'utf8'))
      )
    );
    expect(offenders).toEqual([]);
  });
});
