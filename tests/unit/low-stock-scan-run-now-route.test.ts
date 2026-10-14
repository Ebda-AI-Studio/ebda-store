/**
 * Regression for #189: `stockLowStockAlertOnDemand`
 * (lib/inngest/functions/stock-low-stock-alert.ts) has listened for
 * `stock/low-stock-scan-requested` since it was written, but nothing in the
 * repo ever sent that event — no route, no admin UI action. The "Scan now"
 * button the function's own doc comment describes was unreachable.
 *
 * App-bootstrap pattern matches tests/unit/coupon-validate-targeting-route.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn().mockResolvedValue({ ids: ['evt1'] }) }));

vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: sendMock } }));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'super_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));

let app: Express;

async function buildApp(): Promise<Express> {
  const { default: smartLayerRouter } = await import('@api/routes/smart-layer.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores', smartLayerRouter);
  server.use(errorHandler);
  return server;
}

const STORE_ID = '11111111-1111-1111-1111-111111111111';

describe('POST /:storeId/stock/low-stock-scan/run-now', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => sendMock.mockClear());

  it('sends stock/low-stock-scan-requested with the storeId', async () => {
    const res = await request(app).post(`/api/v1/stores/${STORE_ID}/stock/low-stock-scan/run-now`);

    expect(res.status).toBe(202);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'stock/low-stock-scan-requested',
        data: expect.objectContaining({ storeId: STORE_ID }),
      })
    );
  });
});
