/**
 * Contract Test — FWB ↔ WBS Bridge (FWB side)
 *
 * Asserts the JSON shapes emitted by FWB's /wa-bridge/* endpoints match
 * exactly what WBS's bot code expects to receive. If FWB's response drifts
 * (field renamed, type changed, field removed) this test fails loud before
 * the change reaches production.
 *
 * Strategy:
 *  - vi.mock('@force/database') — no real DB, no Neon connection needed
 *  - vi.mock('../services/encryption.service') — bypass key decrypt
 *  - Boot a minimal Express app mounting only wa-bridge.routes
 *  - Validate all response bodies through Zod schemas derived from WBS
 *    consumption code (wa-bridge-client, botCatalogService, wa-ordering)
 *
 * Auth: `x-wbs-api-key` header. The middleware decrypts the stored key and
 * compares — we short-circuit by mocking the definer's wbsBridgeKeys response
 * so the decrypt path returns a predictable match.
 *
 * Run: npm run test:contract
 *      (or: TEST_DATABASE_URL=sqlite://placeholder vitest run tests/unit/contract-wbs-bridge.test.ts)
 *
 * Why TEST_DATABASE_URL is required: the global tests/setup-e2e.ts fires for
 * all test files and reads the prod DATABASE_URL from .env as a fallback.
 * Setting TEST_DATABASE_URL to any non-prod placeholder bypasses the .env read.
 * This test makes ZERO real DB calls — it's entirely mocked.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { z } from 'zod';

// ─── Zod contract schemas ────────────────────────────────────────────────────
//
// These schemas ARE the contract. They encode exactly what WBS's bot code
// depends on. Update them only when the consuming code on the WBS side is
// updated simultaneously — that's the drift-catch mechanism.

/**
 * Shape returned by GET /wa-bridge/store-catalog (no ?phone param).
 * Derived from:
 *   whatsapp-bulk-sender/backend/src/services/botCatalogService.js
 *   whatsapp-bulk-sender/backend/src/services/waOrderingStateMachine.js
 */
const StoreCatalogSchema = z.object({
  success: z.literal(true),
  catalog: z.object({
    storeId: z.string().uuid(),
    storeName: z.string().min(1),
    storeNameAr: z.string(), // '' is valid (no nameAr)
    currency: z.string().min(1),
    locale: z.unknown(), // string or nested object from settings JSON
    cachedAt: z.string().datetime({ offset: true }),
    categories: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        nameAr: z.string(),
        slug: z.string(),
        position: z.number().int(),
      })
    ),
    products: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        nameAr: z.string(), // '' not null — WBS uses this for AR menus
        descriptionAr: z.string(),
        slug: z.string(),
        price: z.number().int().nonnegative(), // piastres — integer
        compareAtPrice: z.number().int().nonnegative().optional(),
        currency: z.string(),
        categoryIds: z.array(z.string().uuid()),
        inStock: z.boolean(),
        sku: z.string().optional(),
        imageUrl: z.string().optional(),
        variants: z.array(
          z.object({
            id: z.string().uuid(),
            name: z.string(),
            price: z.number().int().nonnegative(),
            inStock: z.boolean(),
          })
        ),
      })
    ),
  }),
  botCopy: z.record(z.string(), z.unknown()).nullable(),
  // customerHistory absent when ?phone not supplied
});

/**
 * Additional shape when ?phone=<E164> is included.
 * WBS reads this on every catalog refresh when the customer is known.
 */
const CustomerHistoryPresentSchema = StoreCatalogSchema.extend({
  customerHistory: z
    .object({
      isReturning: z.boolean(),
      totalOrders: z.number().int().nonnegative(),
      totalSpentFils: z.number().int().nonnegative(),
      firstName: z.string().nullable(),
      preferredLanguage: z.enum(['en', 'ar']).nullable(),
      lastOrder: z
        .object({
          orderId: z.string().uuid(),
          orderNumber: z.string(),
          createdAt: z.string().datetime({ offset: true }),
          totalFils: z.number().int().nonnegative(),
          items: z.array(
            z.object({
              // For a collapsed bundle row (see `isBundle` below) this is
              // the BUNDLE's own id, not a Product id — a bundle box is
              // not one product, only a `bundleGroupId` on its component
              // OrderItems. It must be a resolvable uuid, never null:
              // WBS's `cartFromWaSchema` (`z.string().uuid().optional()`)
              // rejects `null` and 400s the WHOLE repeat-order request
              // (NEW-P1, fixed by emitting `bundleId` here).
              productId: z.string().uuid(),
              productName: z.string(),
              productNameAr: z.string().nullable(),
              quantity: z.number().int().positive(),
              priceFils: z.number().int().nonnegative(),
              isBundle: z.literal(true).optional(),
            })
          ),
        })
        .nullable(),
      frequentCategories: z.array(
        z.object({
          categoryId: z.string().uuid(),
          name: z.string(),
          nameAr: z.string(),
          orderCount: z.number().int().positive(),
        })
      ),
      frequentProducts: z.array(
        z.object({
          productId: z.string().uuid(),
          name: z.string(),
          nameAr: z.string().nullable(),
          priceFils: z.number().int().nonnegative(),
          totalQuantity: z.number().int().positive(),
        })
      ),
    })
    .nullable(),
});

// Unknown phone — returns structured "not returning" object, NOT 404
const CustomerHistoryNotFoundSchema = StoreCatalogSchema.extend({
  customerHistory: z.object({
    isReturning: z.literal(false),
    totalOrders: z.literal(0),
    totalSpentFils: z.literal(0),
    firstName: z.null(),
    preferredLanguage: z.null(),
    lastOrder: z.null(),
    frequentCategories: z.array(z.never()),
    frequentProducts: z.array(z.never()),
  }),
});

// ─── Mock setup ──────────────────────────────────────────────────────────────

// Canonical test data — mirrors what WBS's bot reads
const TEST_STORE_ID = 'aabbccdd-1111-2222-3333-aabbccddeeff';
const TEST_WBS_API_KEY = 'test-wbs-bridge-key-for-contract-test';

const MOCK_STORE = {
  id: TEST_STORE_ID,
  slug: 'test-store',
  name: 'Test Store EN',
  nameAr: 'متجر اختبار',
  currency: 'EGP',
  wbsEnabled: true,
  wbsClientId: 'client-uuid-123',
  credentials: { wbsApiKey: 'encrypted:' + TEST_WBS_API_KEY }, // encryption mock returns the suffix
  settings: { locale: 'ar' },
  botCopy: { greeting_new: 'Hello!' },
};

const MOCK_CATEGORY = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Sweets',
  nameAr: 'حلويات',
  slug: 'sweets',
  position: 1,
};

const MOCK_PRODUCT = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Date Box',
  nameAr: 'علبة تمر',
  descriptionAr: 'وصف المنتج',
  slug: 'date-box',
  price: 3500,
  compareAtPrice: 4000,
  sku: 'DB-001',
  inventory: 50,
  trackInventory: true,
  allowBackorder: false,
  images: [{ url: 'https://r2.example.com/date-box.jpg' }],
  categories: [{ categoryId: MOCK_CATEGORY.id }],
  variants: [],
};

// waBridgeAuth reads the bridge-enabled stores' key ciphertexts through the
// SECURITY DEFINER wrapper (no store scope exists yet), then loads the matched
// store via withStore. Default: one store whose key decrypts to TEST_WBS_API_KEY.
vi.mock('../../apps/api/src/lib/definer', () => ({
  wbsBridgeKeys: vi.fn(async () => [
    { storeId: MOCK_STORE.id, wbsApiKey: MOCK_STORE.credentials.wbsApiKey },
  ]),
}));

// Mock @force/database before importing the route
vi.mock('@force/database', () => {
  const prisma = {
    store: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    category: {
      findMany: vi.fn(),
    },
    product: {
      findMany: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
    order: {
      findMany: vi.fn(),
    },
    // Task 10: listPurchasableBundles (bundle.service.ts) — findMany for the
    // candidate id/updatedAt/description rows, findFirst for resolveBundle's
    // per-bundle resolve.
    bundle: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    bundleItem: {
      findMany: vi.fn(),
    },
  };
  return {
    prisma,
    withStore: (_storeId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
  };
});

// Task 10: /store-catalog now checks the `bundles` feature. Mocked directly
// (rather than mocking @force/database's withRlsBypass/storeFeature that
// FeatureService.readFromDb needs) — same pattern as
// tests/unit/backorder-enforcement.test.ts. Every existing test in this file
// predates bundles and expects the pre-Task-10 catalog shape, so the default
// resolves `false` — see the dedicated bundles describe block below for the
// enabled case.
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn().mockResolvedValue(false),
  },
}));

// Mock encryption service — decrypt strips the 'encrypted:' prefix so the
// stored mock value 'encrypted:<key>' decrypts to '<key>'
vi.mock('../../apps/api/src/services/encryption.service', () => ({
  encryption: {
    decrypt: vi.fn((v: string) => v.replace(/^encrypted:/, '')),
    encrypt: vi.fn((v: string) => 'encrypted:' + v),
  },
}));

// Mock logger to suppress noise
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock config (jwt secret etc.)
vi.mock('../../apps/api/src/config', () => ({
  config: {
    jwtSecret: 'test-jwt-secret-for-contract-tests',
    encryptionKey: 'test-encryption-key-32bytes-here!!',
  },
}));

// ─── App bootstrap ────────────────────────────────────────────────────────────

let app: Express;

async function buildApp(): Promise<Express> {
  // Dynamic import AFTER mocks are wired
  const { default: waBridgeRouter } = await import('../../apps/api/src/routes/wa-bridge.routes');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/wa-bridge', waBridgeRouter);
  return server;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('contract: GET /wa-bridge/store-catalog (FWB → WBS consumer)', () => {
  beforeAll(async () => {
    app = await buildApp();

    // Wire default prisma mocks
    const { prisma } = await import('@force/database');
    (prisma.store.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_STORE]);
    (prisma.store.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STORE);
    (prisma.category.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_CATEGORY]);
    (prisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_PRODUCT]);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null); // unknown phone
    (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // Task 10 defaults: no bundles, feature disabled. Individual bundle
    // tests below override these with mockResolvedValueOnce/mockReturnValueOnce.
    (prisma.bundle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.bundleItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { featureService } = await import('../../apps/api/src/services/feature.service');
    (featureService.isFeatureEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // ── Auth matrix ─────────────────────────────────────────────────────────────

  it('401 — missing x-wbs-api-key header', async () => {
    const res = await request(app).get('/api/v1/wa-bridge/store-catalog');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('401 — wrong api key', async () => {
    // Return no matching store (wrong key)
    const { wbsBridgeKeys } = await import('../../apps/api/src/lib/definer');
    (wbsBridgeKeys as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const res = await request(app)
      .get('/api/v1/wa-bridge/store-catalog')
      .set('x-wbs-api-key', 'completely-wrong-key');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  // ── Happy path — catalog shape ───────────────────────────────────────────────

  it('200 — catalog shape passes Zod contract schema', async () => {
    const res = await request(app)
      .get('/api/v1/wa-bridge/store-catalog')
      .set('x-wbs-api-key', TEST_WBS_API_KEY);

    expect(res.status).toBe(200);
    const parse = StoreCatalogSchema.safeParse(res.body);
    if (!parse.success) {
      console.error('Schema drift detected:', JSON.stringify(parse.error.flatten(), null, 2));
    }
    expect(parse.success).toBe(true);
  });

  it('200 — catalog.products contains required WBS fields', async () => {
    const res = await request(app)
      .get('/api/v1/wa-bridge/store-catalog')
      .set('x-wbs-api-key', TEST_WBS_API_KEY);

    expect(res.status).toBe(200);
    const product = res.body.catalog.products[0];
    // WBS reads these specific fields — any rename is a breaking change
    expect(typeof product.id).toBe('string');
    expect(typeof product.name).toBe('string');
    expect(typeof product.nameAr).toBe('string'); // '' not null — WBS uses this
    expect(typeof product.price).toBe('number'); // piastres integer
    expect(typeof product.inStock).toBe('boolean');
    expect(Array.isArray(product.categoryIds)).toBe(true);
    expect(Array.isArray(product.variants)).toBe(true);
  });

  // Issue 2077: the catalog select used `where: { isActive: true }`, so a
  // product whose variants are ALL disabled filtered to zero variant rows and
  // `effectiveInventory` fell back to the stale parent column — the bot told
  // shoppers it was in stock while the cart refused every variant.
  it('200 — a product whose variants are ALL disabled is out of stock and lists no variants', async () => {
    const { prisma } = await import('@force/database');
    (prisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        ...MOCK_PRODUCT,
        inventory: 50, // stale parent column — must NOT be read as stock
        variants: [
          {
            id: 'v1',
            title: 'Large',
            price: 3500,
            inventory: 9,
            allowBackorder: false,
            isActive: false,
          },
        ],
      },
    ]);
    const res = await request(app)
      .get('/api/v1/wa-bridge/store-catalog')
      .set('x-wbs-api-key', TEST_WBS_API_KEY);

    expect(res.status).toBe(200);
    const product = res.body.catalog.products[0];
    expect(product.inStock).toBe(false);
    expect(product.variants).toEqual([]);
    const args = (prisma.product.findMany as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(args.select.variants.where).toBeUndefined();
    expect(args.select.variants.select.isActive).toBe(true);
  });

  it('200 — botCopy is null or record (not undefined)', async () => {
    const res = await request(app)
      .get('/api/v1/wa-bridge/store-catalog')
      .set('x-wbs-api-key', TEST_WBS_API_KEY);

    expect(res.status).toBe(200);
    // botCopy MUST be present in the response (null or object) — WBS checks `response.botCopy`
    expect('botCopy' in res.body).toBe(true);
    const botCopyCheck = z.record(z.string(), z.unknown()).nullable().safeParse(res.body.botCopy);
    expect(botCopyCheck.success).toBe(true);
  });

  // ── Phone param — unknown customer ──────────────────────────────────────────

  it('200 — unknown phone returns structured customerHistory not 404', async () => {
    // prisma.user.findFirst returns null (unknown phone) — default mock
    const res = await request(app)
      .get('/api/v1/wa-bridge/store-catalog?phone=%2B96512345678')
      .set('x-wbs-api-key', TEST_WBS_API_KEY);

    expect(res.status).toBe(200);
    // Contract: WBS depends on `customerHistory` always having a defined shape —
    // unknown phone returns isReturning:false object, NOT null and NOT 404
    expect(res.body).toHaveProperty('customerHistory');
    const parse = CustomerHistoryNotFoundSchema.safeParse(res.body);
    if (!parse.success) {
      console.error('Unknown-phone shape drift:', JSON.stringify(parse.error.flatten(), null, 2));
    }
    expect(parse.success).toBe(true);
    expect(res.body.customerHistory.isReturning).toBe(false);
    expect(res.body.customerHistory.totalOrders).toBe(0);
    expect(res.body.customerHistory.lastOrder).toBeNull();
  });

  it('200 — oversized phone still returns 200 (WBS passes raw customer input)', async () => {
    // Zod schema accepts min:8 max:20 — >20 chars returns 200 with no customerHistory key
    // (catalogPhoneSchema.safeParse fails silently, customerPhone becomes undefined)
    const res = await request(app)
      .get('/api/v1/wa-bridge/store-catalog?phone=%2B96599999999999999999999') // >20 chars
      .set('x-wbs-api-key', TEST_WBS_API_KEY);

    // Route is permissive — it doesn't 400 on bad phone, just omits customerHistory
    expect(res.status).toBe(200);
    // customerHistory key absent (or null) — both are acceptable for WBS fallback path
    if ('customerHistory' in res.body) {
      expect(res.body.customerHistory).toBeNull();
    }
  });

  // ── Store not found ──────────────────────────────────────────────────────────

  it('404 — store not found after auth', async () => {
    const { prisma } = await import('@force/database');
    // Auth passes (first findUnique returns the store) but the route's own findUnique returns null
    (prisma.store.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(MOCK_STORE)
      .mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/v1/wa-bridge/store-catalog')
      .set('x-wbs-api-key', TEST_WBS_API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // ── Task 10: bundles in the catalogue bridge payload ──────────────────────
  //
  // `bundles` is in NO plan baseline — every test above ran with it
  // defaulted to disabled (see beforeAll) and already proves the pre-Task-10
  // shape is untouched. These tests cover the enabled case.

  const MOCK_BUNDLE_ROW = {
    id: '33333333-3333-3333-3333-333333333333',
    storeId: TEST_STORE_ID,
    name: 'Ramadan Box',
    nameAr: 'علبة رمضان',
    slug: 'ramadan-box',
    image: 'https://r2.example.com/ramadan-box.jpg',
    pricingType: 'fixed_price',
    pricingValue: 9000,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    items: [
      {
        id: 'bundle-item-1',
        quantity: 1,
        variantId: null,
        variant: null,
        product: {
          price: 3500,
          trackInventory: true,
          inventory: 50,
          variants: [],
          deletedAt: null,
          status: 'active',
        },
      },
      {
        id: 'bundle-item-2',
        quantity: 1,
        variantId: null,
        variant: null,
        product: {
          price: 8000,
          trackInventory: true,
          inventory: 50,
          variants: [],
          deletedAt: null,
          status: 'active',
        },
      },
    ],
  };

  describe('bundles feature', () => {
    it('disabled (default): catalog.products contains ONLY the real product — byte-identical to the pre-bundles shape', async () => {
      const res = await request(app)
        .get('/api/v1/wa-bridge/store-catalog')
        .set('x-wbs-api-key', TEST_WBS_API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.catalog.products).toHaveLength(1);
      expect(res.body.catalog.products[0].id).toBe(MOCK_PRODUCT.id);
      expect(res.body.catalog.products.some((p: { isBundle?: boolean }) => p.isBundle)).toBe(false);
      // bundles is disabled -> listPurchasableBundles must never be queried.
      const { prisma } = await import('@force/database');
      expect(prisma.bundle.findMany).not.toHaveBeenCalled();
    });

    it('enabled: a purchasable bundle appears as a sibling product entry with isBundle:true, correct price, and Arabic name — without leaking per-component prices', async () => {
      const { featureService } = await import('../../apps/api/src/services/feature.service');
      const { prisma } = await import('@force/database');
      (featureService.isFeatureEnabled as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
      (prisma.bundle.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: MOCK_BUNDLE_ROW.id,
          updatedAt: new Date('2026-08-01T00:00:00Z'),
          description: null,
          descriptionAr: null,
        },
      ]);
      (prisma.bundle.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(MOCK_BUNDLE_ROW);
      (prisma.bundleItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { bundleId: MOCK_BUNDLE_ROW.id, product: { name: 'Dates', nameAr: 'تمر' } },
        { bundleId: MOCK_BUNDLE_ROW.id, product: { name: 'Honey', nameAr: 'عسل' } },
      ]);

      const res = await request(app)
        .get('/api/v1/wa-bridge/store-catalog')
        .set('x-wbs-api-key', TEST_WBS_API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.catalog.products).toHaveLength(2);
      const bundleEntry = res.body.catalog.products.find(
        (p: { id: string }) => p.id === MOCK_BUNDLE_ROW.id
      );
      expect(bundleEntry).toBeDefined();
      expect(bundleEntry.isBundle).toBe(true);
      expect(bundleEntry.name).toBe('Ramadan Box');
      expect(bundleEntry.nameAr).toBe('علبة رمضان');
      expect(bundleEntry.descriptionAr).toBe('يشمل: تمر، عسل');
      // fixed_price 9000 against componentSum 3500+8000=11500 -> price 9000,
      // compareAtPrice (the "was" reference) is the componentSum.
      expect(bundleEntry.price).toBe(9000);
      expect(bundleEntry.compareAtPrice).toBe(11500);
      expect(bundleEntry.inStock).toBe(true);
      expect(bundleEntry.categoryIds).toEqual([]);
      expect(bundleEntry.variants).toEqual([]);
      // Never the per-component allocated prices (3500 / 8000) or the
      // internal pricingType/pricingValue fields.
      const serialized = JSON.stringify(bundleEntry);
      expect(serialized).not.toContain('"pricingType"');
      expect(serialized).not.toContain('"pricingValue"');
      expect(serialized).not.toContain('3500');
      expect(serialized).not.toContain('8000');
      // The real product entry is unaffected by the bundle being present.
      const productEntry = res.body.catalog.products.find(
        (p: { id: string }) => p.id === MOCK_PRODUCT.id
      );
      expect(productEntry.isBundle).toBeUndefined();
    });
  });

  // ── buildCustomerHistory — the design doc's "the WhatsApp thread [...]
  // render[s] the group as one row" requirement (2026-09-06-product-bundles-
  // design.md, "Customer-facing display"). A returning customer's LAST order
  // feeds the bot's conversational context on every catalog refresh; if it
  // contained a bundle box, the bot must not read the customer's own
  // purchase history back to them as 3 unrelated products at fractional
  // allocated prices.
  describe('customerHistory.lastOrder with a bundle', () => {
    const RETURNING_USER = {
      id: 'cccccccc-4444-4444-4444-cccccccccccc',
      firstName: 'Sara',
      language: 'en',
    };
    const BUNDLE_ID = 'bbbbbbbb-6666-6666-6666-bbbbbbbbbbbb';

    it('collapses a bundle box in lastOrder.items into ONE row — never its per-component allocated prices — and emits the bundle id, not null (NEW-P1)', async () => {
      const { prisma } = await import('@force/database');
      (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RETURNING_USER);
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'dddddddd-5555-5555-5555-dddddddddddd',
          orderNumber: 'ORD-1001',
          createdAt: new Date('2026-09-01T00:00:00Z'),
          total: 12000,
          items: [
            {
              id: 'oi-1',
              productId: '10000000-0000-0000-0000-000000000001',
              productName: 'Dates',
              quantity: 1,
              price: 3724,
              bundleId: BUNDLE_ID,
              bundleGroupId: 'grp-1',
              bundleName: 'Ramadan Box',
              bundleNameAr: 'علبة رمضان',
              product: { nameAr: 'تمر', categories: [] },
            },
            {
              id: 'oi-2',
              productId: '10000000-0000-0000-0000-000000000002',
              productName: 'Honey',
              quantity: 1,
              price: 4966,
              bundleId: BUNDLE_ID,
              bundleGroupId: 'grp-1',
              bundleName: 'Ramadan Box',
              bundleNameAr: 'علبة رمضان',
              product: { nameAr: 'عسل', categories: [] },
            },
            {
              id: 'oi-3',
              productId: '10000000-0000-0000-0000-000000000003',
              productName: 'Nuts',
              quantity: 2,
              price: 1655,
              bundleId: BUNDLE_ID,
              bundleGroupId: 'grp-1',
              bundleName: 'Ramadan Box',
              bundleNameAr: 'علبة رمضان',
              product: { nameAr: 'مكسرات', categories: [] },
            },
          ],
        },
      ]);

      const res = await request(app)
        .get('/api/v1/wa-bridge/store-catalog?phone=%2B96512340001')
        .set('x-wbs-api-key', TEST_WBS_API_KEY);

      expect(res.status).toBe(200);
      const parse = CustomerHistoryPresentSchema.safeParse(res.body);
      if (!parse.success) {
        console.error(
          'customerHistory shape drift:',
          JSON.stringify(parse.error.flatten(), null, 2)
        );
      }
      expect(parse.success).toBe(true);

      const items = res.body.customerHistory.lastOrder.items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        productId: BUNDLE_ID,
        productName: 'Ramadan Box',
        productNameAr: 'علبة رمضان',
        quantity: 1,
        priceFils: 12000,
        isBundle: true,
      });

      // No per-component name or allocated price anywhere in the payload.
      const serialized = JSON.stringify(items);
      expect(serialized).not.toContain('Dates');
      expect(serialized).not.toContain('Honey');
      expect(serialized).not.toContain('Nuts');
      expect(serialized).not.toContain('3724');

      // #1561: frequentProducts iterates the same rows and used to carry each
      // component at its allocated share (Dates 3.724) — a price the bot
      // quotes to the shopper. The whole history payload must be free of it.
      expect(res.body.customerHistory.frequentProducts).toEqual([]);
      const history = JSON.stringify(res.body.customerHistory);
      for (const allocated of ['3724', '4966', '1655']) {
        expect(history).not.toContain(allocated);
      }
    });

    it('NEW-P1: a repeat-order payload built from this bundle row round-trips through cartFromWaSchema (WBS `handleRepeatLastOrder` shape)', async () => {
      const { prisma } = await import('@force/database');
      const { cartFromWaSchema } = await import('../../apps/api/src/routes/wa-bridge.routes');
      (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RETURNING_USER);
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'eeeeeeee-5555-5555-5555-eeeeeeeeeeee',
          orderNumber: 'ORD-1003',
          createdAt: new Date('2026-09-01T00:00:00Z'),
          total: 15500,
          items: [
            {
              id: 'oi-5',
              productId: '10000000-0000-0000-0000-000000000004',
              productName: 'Dates',
              quantity: 1,
              price: 12000,
              bundleId: BUNDLE_ID,
              bundleGroupId: 'grp-2',
              bundleName: 'Ramadan Box',
              bundleNameAr: 'علبة رمضان',
              product: { nameAr: 'تمر', categories: [] },
            },
            {
              id: 'oi-6',
              productId: MOCK_PRODUCT.id,
              productName: 'Date Box',
              quantity: 1,
              price: 3500,
              bundleId: null,
              bundleGroupId: null,
              bundleName: null,
              bundleNameAr: null,
              product: { nameAr: 'علبة تمر', categories: [] },
            },
          ],
        },
      ]);

      const res = await request(app)
        .get('/api/v1/wa-bridge/store-catalog?phone=%2B96512340003')
        .set('x-wbs-api-key', TEST_WBS_API_KEY);

      expect(res.status).toBe(200);
      const lastOrderItems = res.body.customerHistory.lastOrder.items;

      // Mirrors whatsapp-bulk-sender's `handleRepeatLastOrder`
      // (`backend/src/services/wa-ordering.js:476-482`), which maps
      // `customerHistory.lastOrder.items` straight into the
      // `/cart/from-wa` payload shape: `{ productId, quantity }` per line.
      const repeatOrderPayload = {
        items: lastOrderItems.map((i: { productId: string | null; quantity: number }) => ({
          productId: i.productId,
          quantity: i.quantity,
        })),
        waId: '96512340003',
      };

      const parsed = cartFromWaSchema.safeParse(repeatOrderPayload);
      if (!parsed.success) {
        console.error(
          'repeat-order payload rejected by cartFromWaSchema:',
          JSON.stringify(parsed.error.flatten(), null, 2)
        );
      }
      expect(parsed.success).toBe(true);
    });

    it('leaves a non-bundle lastOrder unchanged — one item row per product, same shape as before this fix', async () => {
      const { prisma } = await import('@force/database');
      (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RETURNING_USER);
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'dddddddd-5555-5555-5555-dddddddddddd',
          orderNumber: 'ORD-1002',
          createdAt: new Date('2026-09-01T00:00:00Z'),
          total: 3500,
          items: [
            {
              id: 'oi-4',
              productId: MOCK_PRODUCT.id,
              productName: 'Date Box',
              quantity: 1,
              price: 3500,
              bundleGroupId: null,
              bundleName: null,
              bundleNameAr: null,
              product: { nameAr: 'علبة تمر', categories: [] },
            },
          ],
        },
      ]);

      const res = await request(app)
        .get('/api/v1/wa-bridge/store-catalog?phone=%2B96512340002')
        .set('x-wbs-api-key', TEST_WBS_API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.customerHistory.lastOrder.items).toEqual([
        {
          productId: MOCK_PRODUCT.id,
          productName: 'Date Box',
          productNameAr: 'علبة تمر',
          quantity: 1,
          priceFils: 3500,
        },
      ]);
      // A plain line still feeds frequentProducts at its real price (#1561).
      expect(res.body.customerHistory.frequentProducts).toEqual([
        {
          productId: MOCK_PRODUCT.id,
          name: 'Date Box',
          nameAr: 'علبة تمر',
          priceFils: 3500,
          totalQuantity: 1,
        },
      ]);
    });
  });
});
