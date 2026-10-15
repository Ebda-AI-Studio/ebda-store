/**
 * Verification wave 3 (D1): an oversize image used to be a 500 on /uploads/image and
 * /uploads/images (bare multer; only the video route mapped LIMIT_FILE_SIZE). The central
 * errorHandler now answers every multer error: size -> 413 FILE_TOO_LARGE, any other
 * MulterError -> 400, and a fileFilter rejection -> its own 400. Real router, real multer.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('@api/middleware/store-access', () => ({
  checkStoreAccess: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@api/services/image-resize.service', () => ({
  resizeToAspect: vi.fn(async (buf: Buffer) => buf),
  enforceMaxDimensions: vi.fn(async (buf: Buffer) => buf),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: { uploadMultiple: vi.fn(), upload: vi.fn(), isAvailable: vi.fn(() => true) },
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
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  dailyUploadLimiter: (_req: any, _res: any, next: any) => next(),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock('@ebda/database', () => ({
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));

import { errorHandler } from '@api/middleware/error-handler';

const BIG = Buffer.alloc(11 * 1024 * 1024); // image cap is 10 MB
const BIG_FONT = Buffer.alloc(6 * 1024 * 1024); // font cap is 5 MB

describe('multer errors on the upload routes', () => {
  let app: Express;
  beforeAll(async () => {
    const { default: uploadRouter } = await import('@api/routes/upload.routes');
    app = express();
    app.use('/api/v1/uploads', uploadRouter);
    app.use(errorHandler);
  });

  it('POST /uploads/image over 10 MB -> 413 FILE_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/image?storeId=store-1')
      .attach('file', BIG, { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('POST /uploads/images with one file over 10 MB -> 413 FILE_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/images?storeId=store-1')
      .attach('files', BIG, { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('POST /uploads/font over 5 MB -> 413 FILE_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/font?storeId=store-1')
      .attach('file', BIG_FONT, { filename: 'f.woff2', contentType: 'font/woff2' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('a file in the wrong field is a 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/image?storeId=store-1')
      .attach('wrong', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('LIMIT_UNEXPECTED_FILE');
  });

  it('a rejected mime type is a 400 INVALID_FILE_TYPE, not a 500', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/image?storeId=store-1')
      .attach('file', Buffer.from('x'), {
        filename: 'a.exe',
        contentType: 'application/x-msdownload',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });
});
