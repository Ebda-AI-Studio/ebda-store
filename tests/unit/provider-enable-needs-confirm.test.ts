/**
 * SELF-SERVICE gap A7 review: the legacy enable routes are not a bypass of the confirm step. A merchant turning a
 * non-manual provider ON through `/toggle` (or the payment PUT, or the carrier PUT) gets 409 CONFIRMATION_REQUIRED
 * pointing at /provider-activation/.../activate/preview; turning OFF stays free; manual providers (COD, InstaPay)
 * and super_admin are not affected.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { mockPrisma, mockClearCache, mockAuditLog, currentUser, decryptSpy } = vi.hoisted(() => ({
  decryptSpy: vi.fn(),
  mockPrisma: {
    paymentConfig: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    store: { findUnique: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
  mockClearCache: vi.fn(),
  mockAuditLog: vi.fn(),
  currentUser: { userId: 'admin-1', role: 'store_admin' as string, anonymous: false },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  // Type-only in the route file (`as PaymentProvider` / `: ProviderHealthStatus`
  // casts) — never dereferenced as a value at runtime, so undefined is fine.
  PaymentProvider: undefined,
  ProviderHealthStatus: undefined,
}));

vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, res: any, next: any) => {
    if (currentUser.anonymous) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'x' } });
      return;
    }
    req.user = { userId: currentUser.userId, role: currentUser.role };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: any, _res: any, next: any) => next(),
  paymentSettingsRouteContext: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/security', () => ({
  auditLog: mockAuditLog,
}));

vi.mock('@api/services/payment.service', () => ({
  PaymentService: { clearCache: mockClearCache },
}));

// Reversible stand-in for AES-256-GCM so assertions can name the plaintext
// without a real ENCRYPTION_KEY, exactly like the encryption.service does
// (encrypt/decrypt are inverses) — `mask` is the REAL implementation
// (imported nowhere, reimplemented identically) so the masking-shape
// assertions exercise the real prefix+****+suffix behaviour.
vi.mock('@api/services/encryption.service', () => ({
  encryption: {
    encrypt: (v: string) => `CIPHERTEXT(${v})`,
    decrypt: (v: string) => {
      decryptSpy(v);
      return String(v).replace(/^CIPHERTEXT\(|\)$/g, '');
    },
    mask: (v: string, visibleChars = 4) => {
      if (!v || v.length <= visibleChars * 2) return '****';
      return `${v.substring(0, visibleChars)}****${v.substring(v.length - visibleChars)}`;
    },
  },
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The enable gate itself (a passing test of the stored credentials) is covered elsewhere: here it passes.
vi.mock('@api/services/payment-providers/provider-connection.service', async () => {
  const real = await vi.importActual<any>(
    '@api/services/payment-providers/provider-connection.service'
  );
  return { ...real, assertEnableAllowed: () => undefined };
});

let app: Express;
const STORE_ID = '11111111-1111-1111-1111-111111111111';
const BASE = '/api/v1/payment-settings';
beforeAll(async () => {
  const { default: router } = await import('@api/routes/payment-settings.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use(BASE, router);
  server.use(errorHandler);
  app = server;
});
const row = (provider: string, isEnabled: boolean) => ({
  id: 'cfg-1',
  provider,
  storeId: STORE_ID,
  isEnabled,
  testMode: true,
  credentials: 'enc',
  connectionTest: { ok: true },
  settings: {},
});
beforeEach(() => {
  vi.clearAllMocks();
  currentUser.userId = 'admin-1';
  currentUser.role = 'store_admin';
  mockPrisma.store.findUnique.mockResolvedValue({ id: STORE_ID, ownerId: 'admin-1' });
  mockPrisma.paymentConfig.update.mockImplementation(async ({ data }: any) => ({
    ...row('kashier', false),
    ...data,
  }));
});
const toggle = (provider: string, enabled: boolean) =>
  request(app).post(`${BASE}/store/${STORE_ID}/${provider}/toggle`).send({ enabled });

describe('legacy enable routes need the confirm step', () => {
  it('toggle ON for a gateway is 409 CONFIRMATION_REQUIRED and writes nothing', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(row('kashier', false));
    const res = await toggle('kashier', true);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(res.body.error.message).toContain('/activate/preview');
    expect(mockPrisma.paymentConfig.update).not.toHaveBeenCalled();
  });
  it('turning OFF stays free', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(row('kashier', true));
    expect((await toggle('kashier', false)).status).toBe(200);
  });
  it('a manual provider (COD) is not gated', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(row('cod', false));
    expect((await toggle('cod', true)).status).toBe(200);
  });
  it('super_admin keeps the override', async () => {
    currentUser.role = 'super_admin';
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(row('kashier', false));
    expect((await toggle('kashier', true)).status).toBe(200);
  });
  it('the payment PUT cannot flip a gateway on either', async () => {
    mockPrisma.paymentConfig.findFirst.mockResolvedValue(row('kashier', false));
    const res = await request(app)
      .put(`${BASE}/store/${STORE_ID}/kashier`)
      .send({ provider: 'kashier', isEnabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
  });
  it('the carrier PUT is wired to the same gate', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/api/src/routes/shipping-carrier.routes.ts'),
      'utf8'
    );
    // gated on the off -> on transition only: behaviour is proven in carrier-put-enable-transition.test.ts
    expect(src).toMatch(
      /if \(!existing\?\.enabled\) refuseUnconfirmedEnable\(req\.user\?\.role, carrier\)/
    );
  });
});
