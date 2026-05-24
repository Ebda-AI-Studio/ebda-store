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
 * compares — we short-circuit by mocking the prisma.store.findMany response
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
        price: z.number().int().nonnegative(), // fils — integer
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
              productId: z.string().uuid(),
              productName: z.string(),
              productNameAr: z.string().nullable(),
              quantity: z.number().int().positive(),
              priceFils: z.number().int().nonnegative(),
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
  currency: 'KWD',
  wbsEnabled: true,
  wbsClientId: 'client-uuid-123',
  wbsApiKey: 'encrypted:' + TEST_WBS_API_KEY, // encryption mock returns the suffix
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

// Mock @force/database before importing the route
vi.mock('@force/database', () => ({
  prisma: {
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
    const { prisma } = await import('@force/database');
    // Return no matching store (wrong key)
    (prisma.store.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
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
    expect(typeof product.price).toBe('number'); // fils integer
    expect(typeof product.inStock).toBe('boolean');
    expect(Array.isArray(product.categoryIds)).toBe(true);
    expect(Array.isArray(product.variants)).toBe(true);
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
    // Auth passes (findMany returns the store) but findUnique returns null
    (prisma.store.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/v1/wa-bridge/store-catalog')
      .set('x-wbs-api-key', TEST_WBS_API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
