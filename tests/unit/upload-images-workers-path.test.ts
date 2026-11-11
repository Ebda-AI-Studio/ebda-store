/**
 * POST /uploads/images on the PRODUCTION (Workers) multipart path (review M-3): `multer` is
 * aliased to apps/api/src/cf/stubs/multer-formdata.ts there. A 5th file over
 * IMAGE_UPLOAD_BATCH_MAX must be a 400 LIMIT_FILE_COUNT through the real errorHandler, with
 * nothing stored; 4 files are accepted.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import multer from 'multer';
import stub from '../../apps/api/src/cf/stubs/multer-formdata';

vi.mock('multer', async () => ({
  default: (await import('../../apps/api/src/cf/stubs/multer-formdata')).default,
}));
vi.mock('@api/middleware/store-access', () => ({
  checkStoreAccess: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin', storeId: 'store-1' };
    next();
  },
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  uploadLimiter: (_q: any, _s: any, n: any) => n(),
  dailyUploadLimiter: (_q: any, _s: any, n: any) => n(),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock('@api/services/image-resize.service', () => ({
  resizeToAspect: vi.fn(async (b: Buffer) => b),
  enforceMaxDimensions: vi.fn(async (b: Buffer) => b),
}));
const { uploadMultiple } = vi.hoisted(() => ({
  uploadMultiple: vi.fn(async (files: Array<{ filename: string }>) =>
    files.map(f => ({ key: f.filename, url: `u/${f.filename}`, size: 1, contentType: 'image/png' }))
  ),
}));
vi.mock('@api/services/plan-limit.service', () => ({
  assertStorageRoom: vi.fn(async () => undefined),
}));

vi.mock('@api/services/storage.service', () => ({
  StorageService: { upload: vi.fn(), uploadMultiple, isAvailable: () => true },
}));
vi.mock('@ebda/database', () => ({
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  Prisma: { PrismaClientKnownRequestError: class {} },
}));

import { errorHandler } from '@api/middleware/error-handler';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

describe('POST /uploads/images through the Workers multer stub', () => {
  let app: Express;
  beforeAll(async () => {
    const { default: router } = await import('@api/routes/upload.routes');
    app = express();
    app.use('/u', router);
    app.use(errorHandler);
  });
  beforeEach(() => {
    uploadMultiple.mockClear();
  });

  it('is really running on the stub', () => {
    expect(multer).toBe(stub);
  });

  function post(n: number) {
    let r = request(app).post('/u/images?storeId=store-1');
    for (let i = 0; i < n; i++) {
      r = r.attach('files', PNG, { filename: `${i}.png`, contentType: 'image/png' });
    }
    return r;
  }

  it('5 files is 400 LIMIT_FILE_COUNT and nothing is stored', async () => {
    const res = await post(5);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('LIMIT_FILE_COUNT');
    expect(uploadMultiple).not.toHaveBeenCalled();
  });

  it('4 files (the batch the admin sends) are stored', async () => {
    const res = await post(4);
    expect(res.status).toBe(200);
    expect(res.body.data.files).toHaveLength(4);
  });
});
