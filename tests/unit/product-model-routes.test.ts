/**
 * Product 3D model routes — the upload gate, the per-store feature gate, and
 * the R2 compensation. Drives the REAL router (and the REAL requireFeature
 * middleware) over HTTP with supertest; only auth, storage, the DB service
 * layer and the feature lookup are stubbed.
 *
 * Mutation checks (2026-10-07, each restored byte-identical afterwards):
 *   - drop `requireFeature('product_3d')` from `writeChain`  → the two
 *     "feature switched off" tests go red (201/200 instead of 403);
 *   - replace `validateGlb(bytes)` with `{ ok: true, ... }`   → the
 *     "a PNG renamed .glb" and "Draco" tests go red (upload called);
 *   - delete the compensating `StorageService.delete`          → the
 *     "DB write fails" test goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { buildUsdz, sampleGlb } from '../helpers/glb-fixtures';

const STORE = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';

const m = vi.hoisted(() => ({
  storageRoom: vi.fn(),
  isFeatureEnabled: vi.fn(),
  upload: vi.fn(),
  storageDelete: vi.fn(),
  upsertModel: vi.fn(),
  setUsdz: vi.fn(),
  assertProductInStore: vi.fn(),
  getModelRow: vi.fn(),
  replaceBindings: vi.fn(),
  getAdminModel: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  orphan: vi.fn(),
  invalidate: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@api/services/plan-limit.service', () => ({ assertStorageRoom: m.storageRoom }));

vi.mock('@ebda/database', () => ({
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  prisma: { productModel: { findFirst: m.findFirst, update: m.update, delete: m.del } },
}));
vi.mock('../../apps/api/src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: unknown }).user = { userId: 'u1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../apps/api/src/middleware/rbac', () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../apps/api/src/middleware/store-access', () => ({
  requireStoreAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../apps/api/src/middleware/tenant-context', () => ({
  tenantContext: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../apps/api/src/middleware/security', () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return { uploadLimiter: pass, dailyUploadLimiter: pass, writeLimiter: pass, auditLog: m.audit };
});
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.isFeatureEnabled },
}));
vi.mock('../../apps/api/src/services/plan-entitlements', () => ({
  getEntitlements: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../apps/api/src/utils/store-helpers', () => ({
  resolvePublicStoreId: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../apps/api/src/services/storage.service', () => ({
  StorageService: { upload: m.upload, delete: m.storageDelete },
}));
vi.mock('../../apps/api/src/services/r2-cleanup.service', async importOriginal => ({
  // the REAL ownership rule (the poster check uses it); only the delete and the key lookup are stubbed
  r2KeyBelongsToStore: (
    await importOriginal<typeof import('../../apps/api/src/services/r2-cleanup.service')>()
  ).r2KeyBelongsToStore,
  deleteR2ObjectIfOrphan: m.orphan,
  urlToR2Key: (url: string) =>
    url.startsWith('https://media.test/') ? url.slice('https://media.test/'.length) : null,
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateStoreProductCaches: m.invalidate,
}));
vi.mock('../../apps/api/src/services/product-model.service', () => ({
  ADMIN_MODEL3D_SELECT: {},
  assertProductInStore: m.assertProductInStore,
  getAdminModel: m.getAdminModel,
  getModelRow: m.getModelRow,
  replaceBindings: m.replaceBindings,
  setUsdz: m.setUsdz,
  upsertModel: m.upsertModel,
}));

import productModelRoutes from '../../apps/api/src/routes/product-model.routes';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/stores/:storeId/product-models', productModelRoutes);
  a.use(
    (
      err: { statusCode?: number; code?: string; name?: string },
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      res
        .status(err.statusCode ?? (err.name === 'ZodError' ? 400 : 500))
        .json({ code: err.code ?? err.name });
    }
  );
  return a;
}

const url = (p = '') => `/stores/${STORE}/product-models/${PRODUCT}${p}`;

beforeEach(() => {
  vi.clearAllMocks();
  m.isFeatureEnabled.mockResolvedValue(true);
  m.storageRoom.mockResolvedValue(undefined);
  m.assertProductInStore.mockResolvedValue({ id: PRODUCT });
  m.upload.mockResolvedValue({
    key: `stores/${STORE}/models/x.glb`,
    url: `https://media.test/stores/${STORE}/models/x.glb`,
    size: 100,
    contentType: 'model/gltf-binary',
  });
  m.upsertModel.mockResolvedValue({ previousModelUrl: null, droppedBindings: 0 });
  m.findFirst.mockResolvedValue({ id: 'model-1' });
  m.getModelRow.mockResolvedValue({
    id: 'model-1',
    modelUrl: 'https://media.test/old.glb',
    usdzUrl: null,
    posterUrl: 'https://media.test/old-poster.webp',
  });
  m.update.mockResolvedValue({ id: 'model-1' });
  m.storageDelete.mockResolvedValue(undefined);
});

describe('POST /glb — the upload gate', () => {
  it('stores a valid GLB under models/ with the glTF MIME type, then writes the row', async () => {
    const res = await request(app()).post(url('/glb')).attach('file', Buffer.from(sampleGlb()), {
      filename: 'ring.glb',
      contentType: 'application/octet-stream',
    });
    expect(res.status).toBe(201);
    expect(m.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      'ring.glb',
      expect.objectContaining({
        folder: 'models',
        storeId: STORE,
        contentType: 'model/gltf-binary',
      })
    );
    expect(m.upsertModel).toHaveBeenCalledWith(
      STORE,
      PRODUCT,
      expect.objectContaining({
        materials: [
          { index: 0, name: 'Band' },
          { index: 1, name: 'Stone' },
        ],
      })
    );
    expect(m.invalidate).toHaveBeenCalledWith(STORE);
  });

  it('a store at its plan storage ceiling is refused BEFORE the R2 write (#615)', async () => {
    m.storageRoom.mockRejectedValue(
      Object.assign(new Error('Your plan allows up to 500 MB of storage.'), {
        statusCode: 402,
        code: 'PLAN_LIMIT_REACHED',
      })
    );
    const glb = Buffer.from(sampleGlb());
    const res = await request(app()).post(url('/glb')).attach('file', glb, {
      filename: 'ring.glb',
      contentType: 'application/octet-stream',
    });
    expect(res.status).toBe(402);
    expect(m.storageRoom).toHaveBeenCalledWith(STORE, glb.length);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('rejects a PNG renamed .glb — nothing reaches R2', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(60)]);
    const res = await request(app())
      .post(url('/glb'))
      .attach('file', png, { filename: 'ring.glb' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_MODEL', details: { reason: 'NOT_GLB' } });
    expect(res.body.error.details.messageAr).toMatch(/[؀-ۿ]/);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('rejects a Draco-compressed GLB with its own reason', async () => {
    const res = await request(app())
      .post(url('/glb'))
      .attach(
        'file',
        Buffer.from(sampleGlb({ extensionsRequired: ['KHR_draco_mesh_compression'] })),
        {
          filename: 'ring.glb',
        }
      );
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('UNSUPPORTED_COMPRESSION');
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('a product of another store 404s BEFORE the R2 write', async () => {
    m.assertProductInStore.mockRejectedValue(
      Object.assign(new Error('nf'), { statusCode: 404, code: 'NOT_FOUND' })
    );
    const res = await request(app())
      .post(url('/glb'))
      .attach('file', Buffer.from(sampleGlb()), { filename: 'a.glb' });
    expect(res.status).toBe(404);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('DB write fails → the just-written R2 object is deleted (compensation)', async () => {
    m.upsertModel.mockRejectedValue(new Error('db down'));
    const res = await request(app())
      .post(url('/glb'))
      .attach('file', Buffer.from(sampleGlb()), { filename: 'a.glb' });
    expect(res.status).toBe(500);
    expect(m.storageDelete).toHaveBeenCalledWith(`stores/${STORE}/models/x.glb`);
  });

  it('a replaced model schedules the OLD object for orphan cleanup', async () => {
    m.upsertModel.mockResolvedValue({
      previousModelUrl: 'https://media.test/old.glb',
      droppedBindings: 2,
    });
    const res = await request(app())
      .post(url('/glb'))
      .attach('file', Buffer.from(sampleGlb()), { filename: 'a.glb' });
    expect(res.status).toBe(201);
    expect(res.body.data.droppedBindings).toBe(2);
    expect(m.orphan).toHaveBeenCalledWith('https://media.test/old.glb');
  });

  it('per-store feature switched off → 403 FEATURE_DISABLED, nothing stored', async () => {
    m.isFeatureEnabled.mockResolvedValue(false);
    const res = await request(app())
      .post(url('/glb'))
      .attach('file', Buffer.from(sampleGlb()), { filename: 'a.glb' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(m.upload).not.toHaveBeenCalled();
  });
});

describe('POST /usdz', () => {
  it('accepts a USDZ and rejects anything else', async () => {
    m.setUsdz.mockResolvedValue({ previousUsdzUrl: null });
    m.upload.mockResolvedValue({
      key: 'k.usdz',
      url: 'https://media.test/k.usdz',
      size: 9,
      contentType: 'model/vnd.usdz+zip',
    });
    const ok = await request(app())
      .post(url('/usdz'))
      .attach('file', Buffer.from(buildUsdz()), { filename: 'r.usdz' });
    expect(ok.status).toBe(201);
    expect(m.upload.mock.calls[0][2]).toMatchObject({
      contentType: 'model/vnd.usdz+zip',
      folder: 'models',
    });
    const bad = await request(app())
      .post(url('/usdz'))
      .attach('file', Buffer.from(sampleGlb()), { filename: 'r.usdz' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe('NOT_USDZ');
  });
});

describe('PUT / — details and poster', () => {
  it('refuses a poster that is not in THIS store prefix of our bucket', async () => {
    for (const posterUrl of [
      'https://evil.example/p.png',
      'https://media.test/stores/other-store/p.png',
    ]) {
      const res = await request(app()).put(url()).send({ posterUrl });
      expect(res.status).toBe(400);
    }
    expect(m.update).not.toHaveBeenCalled();
  });

  it('saves a store poster and cleans the replaced one after commit', async () => {
    const posterUrl = `https://media.test/stores/${STORE}/products/p.webp`;
    const res = await request(app())
      .put(url())
      .send({ posterUrl, altText: 'Gold ring', arEnabled: false });
    expect(res.status).toBe(200);
    expect(m.update.mock.calls[0][0].data).toMatchObject({
      posterUrl,
      altText: 'Gold ring',
      arEnabled: false,
    });
    expect(m.orphan).toHaveBeenCalledWith('https://media.test/old-poster.webp');
  });

  it('per-store feature switched off → 403', async () => {
    m.isFeatureEnabled.mockResolvedValue(false);
    const res = await request(app()).put(url()).send({ altText: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE / and GET / stay available when the feature is off', () => {
  it('a store whose feature was switched off can still see and remove its model', async () => {
    m.isFeatureEnabled.mockResolvedValue(false);
    m.getAdminModel.mockResolvedValue({ model: null, options: [] });
    expect((await request(app()).get(url())).status).toBe(200);
    const del = await request(app()).delete(url());
    expect(del.status).toBe(200);
    expect(m.del).toHaveBeenCalledWith({
      where: { id: 'model-1', storeId: expect.any(String) },
    });
    expect(m.orphan).toHaveBeenCalledWith('https://media.test/old.glb');
    expect(m.orphan).toHaveBeenCalledWith('https://media.test/old-poster.webp');
  });
});
