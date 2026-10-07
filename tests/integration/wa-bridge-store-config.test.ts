/**
 * Integration test: wa-bridge store config endpoints
 * - GET /wa-bridge/store/service-menu?storeId=
 * - GET /wa-bridge/store/meta-catalog-config?storeId=
 * - POST /wa-bridge/store/meta-catalog-config
 *
 * Uses mocked Prisma + auth middleware (no real DB needed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStore = {
  id: 'store-test-123',
  botServiceMenu: {
    orderNow: true,
    subscriptionBoxes: false,
    locationsHours: true,
    chatWithAgent: true,
    labels: { en: { orderNow: 'Order Now' }, ar: { orderNow: 'اطلب الآن' } },
  },
  metaCatalogId: 'cat-123',
  metaBusinessId: 'biz-123',
  credentials: { metaAccessToken: 'encrypted-token-xyz' },
};

vi.mock('@force/database', () => ({
  // tests/setup-e2e.ts builds the owner-role fixture client from this export;
  // these suites never touch a database, so a stub is enough.
  createPrismaClient: vi.fn(),
  prisma: {
    store: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    customerAddress: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('@api/services/encryption.service', () => ({
  encryption: {
    encrypt: vi.fn((v: string) => `enc:${v}`),
    decrypt: vi.fn((v: string) => v.replace('enc:', '')),
    isEncrypted: vi.fn((v: string) => v.startsWith('enc:')),
  },
}));

vi.mock('@api/middleware/wa-bridge-auth', () => ({
  waBridgeAuth: (req: any, _res: any, next: any) => {
    req.bridgeStore = { id: 'store-test-123', name: 'Test Store', currency: 'EGP', slug: 'test' };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { prisma } from '@force/database';
import wabridge from '@api/routes/wa-bridge.routes';

const app = express();
app.use(express.json());
app.use('/api/v1/wa-bridge', wabridge);

describe('GET /wa-bridge/store/service-menu', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores any query storeId and scopes to the authenticated bridge store (IDOR fix)', async () => {
    // A connected merchant passing another tenant's storeId in the query must
    // NOT read that store — the route now derives the tenant from the
    // authenticated req.bridgeStore.id (store-test-123 in the mock middleware).
    (prisma.store.findUnique as any).mockResolvedValue(mockStore);
    const res = await request(app)
      .get('/api/v1/wa-bridge/store/service-menu?storeId=store-owned-by-another-tenant')
      .set('X-WBS-API-KEY', 'test-key');
    expect(res.status).toBe(200);
    expect(prisma.store.findUnique).toHaveBeenCalledWith({
      where: { id: 'store-test-123' },
      select: { botServiceMenu: true },
    });
  });

  it('returns 200 + service menu config', async () => {
    (prisma.store.findUnique as any).mockResolvedValue(mockStore);
    const res = await request(app)
      .get('/api/v1/wa-bridge/store/service-menu?storeId=store-test-123')
      .set('X-WBS-API-KEY', 'test-key');
    expect(res.status).toBe(200);
    expect(res.body.data.serviceMenu).toMatchObject({ orderNow: true });
  });

  it('returns default menu when botServiceMenu is null', async () => {
    (prisma.store.findUnique as any).mockResolvedValue({ ...mockStore, botServiceMenu: null });
    const res = await request(app)
      .get('/api/v1/wa-bridge/store/service-menu?storeId=store-test-123')
      .set('X-WBS-API-KEY', 'test-key');
    expect(res.status).toBe(200);
    // Default enables all menu items
    expect(res.body.data.serviceMenu.orderNow).toBe(true);
  });
});

describe('GET /wa-bridge/store/meta-catalog-config', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns catalogId + businessId + hasToken — never returns plain token', async () => {
    (prisma.store.findUnique as any).mockResolvedValue(mockStore);
    const res = await request(app)
      .get('/api/v1/wa-bridge/store/meta-catalog-config?storeId=store-test-123')
      .set('X-WBS-API-KEY', 'test-key');
    expect(res.status).toBe(200);
    expect(res.body.data.catalogId).toBe('cat-123');
    expect(res.body.data.businessId).toBe('biz-123');
    expect(res.body.data.hasToken).toBe(true);
    // Token MUST NOT be in the response
    expect(JSON.stringify(res.body)).not.toContain('encrypted-token-xyz');
  });
});

describe('POST /wa-bridge/store/meta-catalog-config', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when storeId missing', async () => {
    const res = await request(app)
      .post('/api/v1/wa-bridge/store/meta-catalog-config')
      .set('X-WBS-API-KEY', 'test-key')
      .send({ catalogId: 'cat-123', businessId: 'biz-123', accessToken: 'tok' });
    expect(res.status).toBe(400);
  });

  it('saves encrypted token on valid POST', async () => {
    (prisma.store.update as any).mockResolvedValue({});
    const res = await request(app)
      .post('/api/v1/wa-bridge/store/meta-catalog-config')
      .set('X-WBS-API-KEY', 'test-key')
      .send({
        storeId: 'store-test-123',
        catalogId: 'cat-abc',
        businessId: 'biz-abc',
        accessToken: 'my-token',
      });
    expect(res.status).toBe(200);
    // Verify update was called with encrypted token (not plaintext)
    expect(prisma.store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          credentials: {
            upsert: {
              create: { metaAccessToken: 'enc:my-token' },
              update: { metaAccessToken: 'enc:my-token' },
            },
          },
        }),
      })
    );
    // The store actually written is the AUTHENTICATED bridge store, not a
    // trusted echo of the body field.
    expect(prisma.store.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'store-test-123' } })
    );
  });

  it('returns 403 and does NOT write when the body storeId targets another tenant (cross-tenant IDOR)', async () => {
    (prisma.store.update as any).mockResolvedValue({});
    const res = await request(app)
      .post('/api/v1/wa-bridge/store/meta-catalog-config')
      .set('X-WBS-API-KEY', 'test-key')
      .send({
        storeId: 'store-owned-by-another-tenant',
        catalogId: 'cat-abc',
        businessId: 'biz-abc',
        accessToken: 'my-token',
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STORE_MISMATCH');
    expect(prisma.store.update).not.toHaveBeenCalled();
  });
});
