/**
 * Egypt VAT gate, phase 1 (rulings TAX-2, TAX-6) — the HTTP guards.
 *
 * 1. PUT /stores/:id/tax/settings refuses `taxEnabled: true` with 409
 *    TAX_NOT_VERIFIED (bilingual message + a link to the verification card)
 *    unless the store's VAT registration is VERIFIED; switching OFF and the
 *    inclusive preference always pass. Runs the REAL TaxService on a mocked
 *    prisma, so the guard is exercised where it lives.
 *    Mutation proof: deleting the `if (settings.taxEnabled === true && …)`
 *    block in tax.service.ts reddens "unverified → 409" for every status.
 *
 * 2. The super-admin surfaces (review queue, decision, document bytes,
 *    Ebda's own VAT setting) answer ONLY to role super_admin. Runs the REAL
 *    `authorize` middleware; `authenticate` is stubbed to read the role from a
 *    test header. Mutation proof: replacing `authorize('super_admin')` in
 *    platform-tax.routes.ts with `authorize('store_admin', 'super_admin')`
 *    reddens every store_admin → 403 case (and the services get called).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express, type Request } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  profileFindUnique: vi.fn(),
  storeUpdate: vi.fn(),
  review: vi.fn(),
  discard: vi.fn(),
  getProfile: vi.fn(),
  readDocument: vi.fn(),
  getPlatformVat: vi.fn(),
  updatePlatformVat: vi.fn(),
  queue: vi.fn(),
  bust: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@api/middleware/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  return {
    ...actual,
    // The real `authorize`; authenticate reads the role from a test header.
    authenticate: (req: Request, _res: unknown, next: () => void) => {
      const role = req.header('x-test-role');
      if (role) (req as Request & { user: unknown }).user = { userId: 'u-1', role };
      next();
    },
  };
});
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
vi.mock('@api/middleware/require-mfa', () => ({ requireMfaEnrolled: pass }));
vi.mock('@api/middleware/store-access', () => ({ requireStoreAccess: pass }));
vi.mock('@api/middleware/tenant-context', () => ({ tenantContext: pass }));
vi.mock('@api/services/store.service', () => ({ bustStoreCachesById: h.bust }));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: (_n: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('@api/lib/definer', () => ({ taxProfilesForReview: h.queue }));
// A review decision also drops a stale pending change request (system_settings, not part of this file's database mock).
vi.mock('@api/services/tax-change.service', () => ({
  discardTaxChange: h.discard,
  decideTaxChange: vi.fn(),
  listTaxChangesForReview: vi.fn(),
  readTaxChangeEvidence: vi.fn(),
}));
vi.mock('@api/services/platform-vat.service', () => ({
  getPlatformVat: h.getPlatformVat,
  updatePlatformVat: h.updatePlatformVat,
}));
vi.mock('@ebda/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: Record<string, any> = {
    Prisma: {},
    withUser: (_u: string, fn: () => Promise<unknown>) => fn(),
    prisma: {
      storeTaxProfile: { findUnique: h.profileFindUnique },
      store: { update: h.storeUpdate },
    },
  };
  mod.withStore = (_id: string, fn: (tx: unknown) => unknown) => fn(mod.prisma);
  return mod;
});

const STORE = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
let app: Express;

// The REAL isVerified (the settings gate under test); the super-admin handlers'
// delegates are mocks so a leaked call is visible.
vi.mock('@api/services/tax-profile.service', async () => {
  const actual = await vi.importActual<typeof import('@api/services/tax-profile.service')>(
    '@api/services/tax-profile.service'
  );
  return {
    ...actual,
    TaxProfileService: {
      isVerified: actual.TaxProfileService.isVerified.bind(actual.TaxProfileService),
      review: h.review,
      get: h.getProfile,
      readDocument: h.readDocument,
    },
  };
});

beforeAll(async () => {
  const { default: taxRouter } = await import('@api/routes/tax.routes');
  const { default: platformRouter } = await import('@api/routes/platform-tax.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores', taxRouter);
  app.use('/admin', platformRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  vi.clearAllMocks();
  h.storeUpdate.mockResolvedValue({
    taxEnabled: true,
    taxIncludedInPrice: false,
    defaultTaxRate: null,
  });
  h.review.mockResolvedValue({ status: 'verified' });
  h.discard.mockResolvedValue(undefined);
  h.getProfile.mockResolvedValue({ status: 'pending', documents: [] });
  h.readDocument.mockResolvedValue({
    body: Buffer.from('%PDF-1.4'),
    mimeType: 'application/pdf',
    fileName: 'card.pdf',
  });
  h.getPlatformVat.mockResolvedValue({
    enabled: false,
    rate: 14,
    mode: 'exclusive',
    trn: null,
    legalName: null,
  });
  h.updatePlatformVat.mockResolvedValue({});
  h.queue.mockResolvedValue([]);
});

describe('PUT /stores/:id/tax/settings — VAT can be enabled only when VERIFIED (ruling TAX-2)', () => {
  it.each([null, 'none', 'pending', 'rejected', 'revoked'])(
    'profile %s + taxEnabled:true → 409 TAX_NOT_VERIFIED, nothing written',
    async status => {
      h.profileFindUnique.mockResolvedValue(status === null ? null : { status });
      const res = await request(app)
        .put(`/stores/${STORE}/tax/settings`)
        .set('x-test-role', 'store_admin')
        .send({ taxEnabled: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TAX_NOT_VERIFIED');
      // Bilingual: the Arabic half is present, and the link to the card.
      expect(res.body.error.message).toMatch(/verified/);
      expect(res.body.error.message).toMatch(/ضريبة القيمة المضافة/);
      expect(res.body.error.details.verificationPath).toBe(`/stores/${STORE}/tax#vat-registration`);
      expect(h.storeUpdate).not.toHaveBeenCalled();
    }
  );

  it('verified + taxEnabled:true → 200 and written', async () => {
    h.profileFindUnique.mockResolvedValue({ status: 'verified' });
    const res = await request(app)
      .put(`/stores/${STORE}/tax/settings`)
      .set('x-test-role', 'store_admin')
      .send({ taxEnabled: true });
    expect(res.status).toBe(200);
    expect(h.storeUpdate).toHaveBeenCalledTimes(1);
  });

  it('switching OFF is always allowed (unverified store)', async () => {
    h.profileFindUnique.mockResolvedValue(null);
    h.storeUpdate.mockResolvedValue({ taxEnabled: false, taxIncludedInPrice: false });
    const res = await request(app)
      .put(`/stores/${STORE}/tax/settings`)
      .set('x-test-role', 'store_admin')
      .send({ taxEnabled: false });
    expect(res.status).toBe(200);
    expect(h.storeUpdate).toHaveBeenCalledTimes(1);
  });

  it('the inclusive preference alone is not gated', async () => {
    h.profileFindUnique.mockResolvedValue(null);
    const res = await request(app)
      .put(`/stores/${STORE}/tax/settings`)
      .set('x-test-role', 'store_admin')
      .send({ taxIncludedInPrice: true });
    expect(res.status).toBe(200);
  });
});

describe('super-admin tax surfaces answer ONLY to super_admin (rulings TAX-2, TAX-6)', () => {
  const cases = [
    ['get', '/admin/tax-verification', undefined],
    ['get', `/admin/tax-verification/${STORE}`, undefined],
    ['get', `/admin/tax-verification/${STORE}/documents/${DOC}/file`, undefined],
    ['post', `/admin/tax-verification/${STORE}/decision`, { decision: 'approve' }],
    ['get', '/admin/platform-vat', undefined],
    [
      'put',
      '/admin/platform-vat',
      { enabled: false, rate: 14, mode: 'exclusive', trn: null, legalName: null },
    ],
  ] as const;

  it.each(cases)('store_admin → 403 on %s %s, no service reached', async (method, url, body) => {
    const res = await request(app)[method](url).set('x-test-role', 'store_admin').send(body);
    expect(res.status).toBe(403);
    expect(h.review).not.toHaveBeenCalled();
    expect(h.getProfile).not.toHaveBeenCalled();
    expect(h.readDocument).not.toHaveBeenCalled();
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.getPlatformVat).not.toHaveBeenCalled();
    expect(h.updatePlatformVat).not.toHaveBeenCalled();
  });

  it.each(cases)('anonymous → 401 on %s %s', async (method, url, body) => {
    const res = await request(app)[method](url).send(body);
    expect(res.status).toBe(401);
  });

  it.each(cases)('super_admin → 2xx on %s %s', async (method, url, body) => {
    const res = await request(app)[method](url).set('x-test-role', 'super_admin').send(body);
    expect(res.status).toBeLessThan(300);
  });

  it.each([
    [{ decision: 'approve' }],
    [{ decision: 'reject', reason: 'unreadable document' }],
    [{ decision: 'revoke', reason: 'no longer registered' }],
  ])('every review decision (%j) also discards a stale pending change request', async body => {
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/decision`)
      .set('x-test-role', 'super_admin')
      .send(body);
    expect(res.status).toBe(200);
    expect(h.discard).toHaveBeenCalledWith(
      STORE,
      expect.objectContaining({ userId: expect.any(String) })
    );
  });

  it('a failing discard fails the decision (500), it is not swallowed', async () => {
    h.discard.mockRejectedValueOnce(new Error('settings down'));
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/decision`)
      .set('x-test-role', 'super_admin')
      .send({ decision: 'approve' });
    expect(res.status).toBe(500);
  });

  it('a reject without a reason is refused (400) before the service', async () => {
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/decision`)
      .set('x-test-role', 'super_admin')
      .send({ decision: 'reject' });
    expect(res.status).toBe(400);
    expect(h.review).not.toHaveBeenCalled();
  });

  it('a document is served as a private, non-sniffable download', async () => {
    const res = await request(app)
      .get(`/admin/tax-verification/${STORE}/documents/${DOC}/file`)
      .set('x-test-role', 'super_admin');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });
});
