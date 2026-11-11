/**
 * #1054 — resolveFolderAndStore() returned { ok: true, storeId: null } for a
 * super_admin upload with no storeId, but storage.service.ts's composeKey()
 * throws AppError(400, 'MISSING_TENANT') for EVERY folder in the route's own
 * ALLOWED_FOLDERS allowlist — there is no tenant-less key it will ever
 * accept (hardened 2026-08-09 after 9 unattributable R2 objects). The route
 * let such a request past its own check only to have the service reject it
 * later, after the upload buffer was already touched.
 *
 * #1048 — POST /uploads/images (the multi-file batch route) uploaded raw
 * buffers with no enforceMaxDimensions() ceiling, unlike POST /uploads/image
 * (single-file), which does. A multi-select gallery upload could store
 * camera originals at full size — see enforceMaxDimensions' doc comment for
 * the incident (178 MB of originals, including a 28 MB PNG) this guards
 * against.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { Request } from 'express';
import express, { type Express } from 'express';
import request from 'supertest';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF_BYTES = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');

vi.mock('@api/middleware/store-access', () => ({
  checkStoreAccess: vi.fn(async () => ({ ok: true })),
}));

const { enforceMaxDimensionsMock, uploadMultipleMock } = vi.hoisted(() => ({
  enforceMaxDimensionsMock: vi.fn(async (buf: Buffer) => buf),
  uploadMultipleMock: vi.fn(async (files: Array<{ buffer: Buffer; filename: string }>) =>
    files.map((f, i) => ({
      key: `stores/store-1/misc/${i}-${f.filename}`,
      url: `https://cdn.example/${i}`,
      size: f.buffer.length,
      contentType: 'image/png',
    }))
  ),
}));

vi.mock('@api/services/image-resize.service', () => ({
  resizeToAspect: vi.fn(async (buf: Buffer) => buf),
  enforceMaxDimensions: enforceMaxDimensionsMock,
}));

vi.mock('@api/services/plan-limit.service', () => ({
  assertStorageRoom: vi.fn(async () => undefined),
}));

vi.mock('@api/services/storage.service', () => ({
  StorageService: {
    uploadMultiple: uploadMultipleMock,
    upload: vi.fn(),
    isAvailable: vi.fn(() => true),
  },
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

import { resolveFolderAndStore } from '@api/routes/upload.routes';

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    query: {},
    headers: {},
    user: undefined,
    ...overrides,
  } as unknown as Request;
}

describe('resolveFolderAndStore (#1054)', () => {
  it('rejects a super_admin upload with no storeId — matches composeKey, does not fall through', async () => {
    const req = fakeRequest({ user: { role: 'super_admin', userId: 'u1' } as any });

    const result = await resolveFolderAndStore(req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error.code).toBe('MISSING_TENANT');
    }
  });

  it('still rejects a non-super-admin upload with no storeId (unchanged, more specific 403)', async () => {
    const req = fakeRequest({ user: { role: 'store_admin', userId: 'u1' } as any });

    const result = await resolveFolderAndStore(req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error.code).toBe('FORBIDDEN');
    }
  });

  it('still resolves normally when a storeId IS present', async () => {
    const req = fakeRequest({
      query: { storeId: 'store-1' },
      user: { role: 'store_admin', userId: 'u1' } as any,
    });

    const result = await resolveFolderAndStore(req);

    expect(result).toMatchObject({ ok: true, folder: 'misc', storeId: 'store-1' });
  });
});

describe('POST /uploads/images (#1048)', () => {
  let app: Express;

  beforeAll(async () => {
    const { default: uploadRouter } = await import('@api/routes/upload.routes');
    app = express();
    app.use('/api/v1/uploads', uploadRouter);
  });

  afterEach(() => {
    enforceMaxDimensionsMock.mockClear();
    uploadMultipleMock.mockClear();
  });

  it('runs enforceMaxDimensions on EVERY file in the batch, same as the single-file route', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/images?storeId=store-1')
      .attach('files', PNG_BYTES, 'a.png')
      .attach('files', PNG_BYTES, 'b.png');

    expect(res.status).toBe(200);
    expect(enforceMaxDimensionsMock).toHaveBeenCalledTimes(2);
    // The CAPPED buffer is what reaches StorageService, not the raw upload.
    const uploadedFiles = uploadMultipleMock.mock.calls[0][0] as Array<{ buffer: Buffer }>;
    expect(uploadedFiles).toHaveLength(2);
  });
});

describe('image uploads are judged by their bytes (B0-46)', () => {
  let app: Express;
  beforeAll(async () => {
    const { default: uploadRouter } = await import('@api/routes/upload.routes');
    app = express();
    app.use('/api/v1/uploads', uploadRouter);
  });
  afterEach(() => {
    uploadMultipleMock.mockClear();
    enforceMaxDimensionsMock.mockReset();
    enforceMaxDimensionsMock.mockImplementation(async (buf: Buffer) => buf);
  });

  it('/image refuses HTML declared as image/png, before storage', async () => {
    const { StorageService } = await import('@api/services/storage.service');
    const res = await request(app)
      .post('/api/v1/uploads/image?storeId=store-1')
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'x.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMAGE_CONTENT');
    expect(StorageService.upload).not.toHaveBeenCalled();
  });

  it('/image stores under the name its bytes earn: a JPEG called .png is saved as .jpg', async () => {
    const { StorageService } = await import('@api/services/storage.service');
    (StorageService.upload as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: 'k',
      url: 'u',
      size: 6,
      contentType: 'image/jpeg',
    });
    const res = await request(app)
      .post('/api/v1/uploads/image?storeId=store-1')
      .attach('file', JPEG_BYTES, { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect((StorageService.upload as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toBe(
      'photo.jpg'
    );
  });

  it('/image: a GIF the resizer re-encoded to JPEG is named by its OUTPUT bytes', async () => {
    const { StorageService } = await import('@api/services/storage.service');
    enforceMaxDimensionsMock.mockImplementation(async () => JPEG_BYTES);
    await request(app)
      .post('/api/v1/uploads/image?storeId=store-1')
      .attach('file', GIF_BYTES, { filename: 'anim.gif', contentType: 'image/gif' });
    expect((StorageService.upload as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toBe(
      'anim.jpg'
    );
  });

  it('/images refuses the whole batch when one file is not an image', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/images?storeId=store-1')
      .attach('files', PNG_BYTES, 'a.png')
      .attach('files', Buffer.from('<html>'), 'b.png');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMAGE_CONTENT');
    expect(uploadMultipleMock).not.toHaveBeenCalled();
  });

  it('/images names WHICH files it refused, by index, so the admin can re-send the rest', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/images?storeId=store-1')
      .attach('files', PNG_BYTES, 'a.png')
      .attach('files', Buffer.from('<html>'), 'b.png')
      .attach('files', JPEG_BYTES, 'c.jpg')
      .attach('files', Buffer.from('<svg/>'), 'd.png');
    expect(res.status).toBe(400);
    expect(res.body.error.details.invalidIndexes).toEqual([1, 3]);
    expect(res.body.error.details.messageAr).toMatch(/[\u0600-\u06FF]/);
  });
});

describe('font uploads are judged by their bytes (B0-46 class sweep)', () => {
  let app: Express;
  beforeAll(async () => {
    const { default: uploadRouter } = await import('@api/routes/upload.routes');
    app = express();
    app.use('/api/v1/uploads', uploadRouter);
  });

  it('/font refuses HTML called .woff2, before storage, with a bilingual message', async () => {
    const { StorageService } = await import('@api/services/storage.service');
    const upload = StorageService.upload as ReturnType<typeof vi.fn>;
    upload.mockClear();
    const res = await request(app)
      .post('/api/v1/uploads/font?storeId=store-1')
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'evil.woff2',
        contentType: 'font/woff2',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FONT_CONTENT');
    expect(res.body.error.details.messageEn).toBeTruthy();
    expect(res.body.error.details.messageAr).toMatch(/[؀-ۿ]/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('/font names the stored file and Content-Type by the bytes: WOFF2 bytes called .ttf', async () => {
    const { StorageService } = await import('@api/services/storage.service');
    const upload = StorageService.upload as ReturnType<typeof vi.fn>;
    upload.mockResolvedValue({ key: 'k', url: 'u', size: 8, contentType: 'font/woff2' });
    const res = await request(app)
      .post('/api/v1/uploads/font?storeId=store-1')
      .attach('file', Buffer.from('wOF2abcd'), {
        filename: 'brand.ttf',
        contentType: 'font/ttf',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.format).toBe('woff2');
    const call = upload.mock.calls.at(-1)!;
    expect(call[1]).toBe('brand.woff2');
    expect(call[2].contentType).toBe('font/woff2');
  });

  it('/image refusal carries the message in both languages', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/image?storeId=store-1')
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
        filename: 'x.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.details.messageEn).toBe(res.body.error.message);
    expect(res.body.error.details.messageAr).toMatch(/[؀-ۿ]/);
  });
});

describe('POST /uploads/images file-count ceiling (FU46-6)', () => {
  it('refuses a 5-file batch: the server buffers at most IMAGE_UPLOAD_BATCH_MAX files', async () => {
    const { default: uploadRouter } = await import('@api/routes/upload.routes');
    const a = express();
    a.use('/api/v1/uploads', uploadRouter);
    let r = request(a).post('/api/v1/uploads/images?storeId=store-1');
    for (let i = 0; i < 5; i++) r = r.attach('files', PNG_BYTES, `${i}.png`);
    const res = await r;
    // No errorHandler in this harness (its Prisma import is mocked away), so assert the
    // refusal itself: not stored, not 200.
    expect(res.status).not.toBe(200);
    expect(uploadMultipleMock).not.toHaveBeenCalled();
  });
});
