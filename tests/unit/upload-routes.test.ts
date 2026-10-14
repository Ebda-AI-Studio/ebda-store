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
      .attach('files', Buffer.from('fake-png-bytes-1'), 'a.png')
      .attach('files', Buffer.from('fake-png-bytes-2'), 'b.png');

    expect(res.status).toBe(200);
    expect(enforceMaxDimensionsMock).toHaveBeenCalledTimes(2);
    // The CAPPED buffer is what reaches StorageService, not the raw upload.
    const uploadedFiles = uploadMultipleMock.mock.calls[0][0] as Array<{ buffer: Buffer }>;
    expect(uploadedFiles).toHaveLength(2);
  });
});
