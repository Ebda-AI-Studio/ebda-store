/**
 * POST /stores/:storeId/pwa/icons on the Workers-safe path (Ruling FU46-8): no `sharp`, so the
 * route decides from the bytes — a square PNG of at least 512×512, at most PWA_ICON_MAX_BYTES —
 * and refuses everything else with a bilingual 400 before anything is generated or stored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { fakePng, JPEG_BYTES } from '../helpers/png-fixtures';

const h = vi.hoisted(() => ({
  generate: vi.fn(async () => ({ icon512: 'https://cdn.example/new.png' })),
  updateSettings: vi.fn(async () => ({ pwaEnabled: true })),
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
vi.mock('@ebda/database', () => ({
  prisma: { store: { findUnique: vi.fn(async () => ({ pwaSettings: {} })) } },
  Prisma: { PrismaClientKnownRequestError: class {} },
}));
vi.mock('@api/services/r2-cleanup.service', () => ({ cleanupRemovedJsonUrls: vi.fn() }));
vi.mock('@api/services/pwa.service', () => ({
  PWAService: { updateSettings: h.updateSettings },
  generatePwaIconSet: h.generate,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import pwaRoutes from '@api/routes/pwa.routes';
import { errorHandler } from '@api/middleware/error-handler';

const STORE = '11111111-1111-4111-8111-111111111111';
const app = express();
app.use(pwaRoutes);
app.use(errorHandler);

const send = (buf: Buffer, contentType = 'image/png', filename = 'icon.png') =>
  request(app).post(`/${STORE}/pwa/icons`).attach('source', buf, { filename, contentType });

describe('PWA icon source is judged by its bytes', () => {
  beforeEach(() => h.generate.mockClear());

  it('a 512×512 PNG is accepted and generated from', async () => {
    const res = await send(fakePng(512, 512));
    expect(res.status).toBe(200);
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'JPEG bytes declared as PNG', buf: JPEG_BYTES, code: 'ICON_NOT_PNG' },
    {
      label: 'HTML declared as PNG',
      buf: Buffer.from('<html><script>1</script></html>'),
      code: 'ICON_NOT_PNG',
    },
    { label: 'a 256x256 PNG', buf: fakePng(256, 256), code: 'ICON_TOO_SMALL' },
    { label: 'a 600x512 PNG', buf: fakePng(600, 512), code: 'ICON_NOT_SQUARE' },
  ])('$label → 400 $code, bilingual, nothing generated', async ({ buf, code }) => {
    const res = await send(buf);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.details.messageAr).toMatch(/[\u0600-\u06FF]/);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('SVG is refused by the declared-type filter', async () => {
    const res = await send(Buffer.from('<svg/>'), 'image/svg+xml', 'i.svg');
    expect(res.status).toBe(400);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('a source over 1 MB is 413 before it is parsed', async () => {
    const res = await send(fakePng(512, 512, 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(h.generate).not.toHaveBeenCalled();
  });
});
