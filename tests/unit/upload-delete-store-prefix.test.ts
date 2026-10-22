/**
 * DELETE /uploads/:key (the explicit file delete route): the key must be inside the caller's own
 * store namespace, by the SAME rule the R2 cleanup uses (`r2KeyBelongsToStore`): an exact prefix, no
 * `..` segment, no look-alike store id. A hand-rolled `startsWith` here let `stores/<mine>/../<other>/x`
 * through the prefix test.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

const h = vi.hoisted(() => ({ del: vi.fn().mockResolvedValue(undefined) }));
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
vi.mock('@api/services/storage.service', () => ({
  StorageService: { upload: vi.fn(), delete: h.del, isAvailable: () => true },
}));
vi.mock('@ebda/database', () => ({
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  Prisma: { PrismaClientKnownRequestError: class {} },
}));

import { errorHandler } from '@api/middleware/error-handler';

describe('DELETE /uploads/:key', () => {
  let app: Express;
  beforeAll(async () => {
    const { default: router } = await import('@api/routes/upload.routes');
    app = express();
    app.use('/u', router);
    app.use(errorHandler);
  });
  beforeEach(() => h.del.mockClear());
  const del = (key: string) => request(app).delete(`/u/${key}`).set('x-store-id', 'store-1');

  it('deletes a file in the caller`s own namespace', async () => {
    const res = await del('stores/store-1/images/a.jpg');
    expect(res.status).toBe(200);
    expect(h.del).toHaveBeenCalledWith('stores/store-1/images/a.jpg');
  });

  it('refuses another store`s file, a look-alike store id, and a path-traversal into another store', async () => {
    for (const [key, status] of [
      ['stores/store-2/images/a.jpg', 403],
      ['stores/store-10/images/a.jpg', 403],
      ['stores/store-1/../store-2/images/a.jpg', 400],
      ['stores/store-1/%2e%2e/store-2/images/a.jpg', 400],
      ['store-1/../stores/store-2/images/a.jpg', 400],
    ] as const) {
      const res = await del(key);
      expect(res.status, key).toBe(status);
    }
    // another store's object survives every one of them
    expect(h.del).not.toHaveBeenCalled();
  });

  it('still honours the oldest `<storeId>/` keys for the caller`s own store only', async () => {
    expect((await del('store-1/old.jpg')).status).toBe(200);
    expect((await del('store-2/old.jpg')).status).toBe(403);
    expect(h.del).toHaveBeenCalledTimes(1);
  });
});
