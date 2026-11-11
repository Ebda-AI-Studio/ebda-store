/**
 * Issue 2201 — every PWA icon generation writes NEW versioned keys, so each
 * upload leaves the previous generation's icons unreferenced in R2. They were
 * left for an opt-in orphan sweeper; the route now hands the old and new
 * `pwaSettings` to `cleanupRemovedJsonUrls` (which re-checks every URL against
 * the shared reference registry before deleting anything).
 *
 * Mutation proof: delete the `cleanupRemovedJsonUrls(...)` call in pwa.routes.ts → red.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { fakePng } from '../helpers/png-fixtures';

const h = vi.hoisted(() => ({
  cleanup: vi.fn().mockResolvedValue(undefined),
  storeFindUnique: vi.fn(),
  generate: vi.fn(),
  updateSettings: vi.fn(),
  pass: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/plan-limit.service', () => ({
  assertStorageRoom: vi.fn(async () => undefined),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', role: 'store_admin' };
    next();
  },
  authorize: () => h.pass,
}));
vi.mock('@api/middleware/store-access', () => ({ requireStoreAccess: h.pass }));
vi.mock('@api/middleware/feature-gate', () => ({ requireFeature: () => h.pass }));
vi.mock('@api/middleware/security', () => ({
  uploadLimiter: h.pass,
  dailyUploadLimiter: h.pass,
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/middleware/tenant-context', () => ({ tenantContext: h.pass }));
vi.mock('@ebda/database', () => ({ prisma: { store: { findUnique: h.storeFindUnique } } }));
vi.mock('@api/services/r2-cleanup.service', () => ({ cleanupRemovedJsonUrls: h.cleanup }));
vi.mock('@api/services/pwa.service', () => ({
  PWAService: { updateSettings: h.updateSettings },
  generatePwaIconSet: h.generate,
}));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import pwaRoutes from '@api/routes/pwa.routes';
import { errorHandler } from '@api/middleware/error-handler';

const STORE = '11111111-1111-4111-8111-111111111111';

describe('POST /:storeId/pwa/icons — superseded generation is cleaned up', () => {
  it('diffs the previous pwaSettings against the new icon set', async () => {
    const previous = { icon512: 'https://cdn.example.com/stores/s/pwa/icon-512.v1.png' };
    const generated = { icon512: 'https://cdn.example.com/stores/s/pwa/icon-512.v2.png' };
    h.storeFindUnique.mockResolvedValue({ pwaSettings: previous });
    h.generate.mockResolvedValue(generated);
    h.updateSettings.mockResolvedValue({ pwaEnabled: true });

    const app = express();
    app.use(pwaRoutes);
    app.use(errorHandler);
    const png = fakePng(512, 512);

    const res = await request(app)
      .post(`/${STORE}/pwa/icons`)
      .attach('source', png, { filename: 'icon.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(h.cleanup).toHaveBeenCalledWith(previous, { ...previous, ...generated });
  });
});
