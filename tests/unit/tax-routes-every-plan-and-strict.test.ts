/**
 * Issues 2357 + 2358, ruling TAX-1a.
 *
 * 2358 — tax COLLECTION is not a plan feature (ruling TAX-1, kept by TAX-2, which adds the
 * verified-VAT-registration gate in the resolver and the settings service; a
 * legal obligation, not a plan feature), so the switch that turns it off and
 * the rate list that sets what it charges must answer on EVERY plan. The
 * feature gate is mocked to deny everything, exactly a store that lapsed to
 * `free`: every route must still answer. Mutation-proof: re-adding
 * `requireFeature('tax')` to any route reddens its case.
 *
 * 2357 — the charge sums every active rate and reads nothing else, so the
 * fields it does not read are REJECTED (400), never accepted and ignored: a
 * merchant who set "KW 5%" + "SA 15%" had every order charged 20%.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  getSettings: vi.fn(),
  listRates: vi.fn(),
  getRate: vi.fn(),
  createRate: vi.fn(),
  updateRate: vi.fn(),
  deleteRate: vi.fn(),
  toggleRate: vi.fn(),
}));

const pass = (_req: unknown, _res: unknown, next: () => void) => next();
vi.mock('@api/middleware/auth', () => ({ authenticate: pass, authorize: () => pass }));
vi.mock('@api/middleware/store-access', () => ({ requireStoreAccess: pass }));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// A store WITHOUT the `tax` feature (the lapsed-payment `free` plan).
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
      res.status(403).json({ success: false, error: { code: 'FEATURE_DISABLED' } }),
}));
vi.mock('@api/services/tax.service', () => ({ TaxService: h }));

const STORE = '11111111-1111-4111-8111-111111111111';
const RATE = '22222222-2222-4222-8222-222222222222';
let app: Express;

beforeAll(async () => {
  const { default: router } = await import('@api/routes/tax.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores', router);
  app.use(errorHandler);
});

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettings.mockResolvedValue({
    taxEnabled: true,
    taxIncludedInPrice: false,
    defaultTaxRate: null,
  });
  h.updateSettings.mockResolvedValue({
    taxEnabled: false,
    taxIncludedInPrice: false,
    defaultTaxRate: null,
  });
  h.listRates.mockResolvedValue([]);
  h.getRate.mockResolvedValue({ id: RATE, rate: 5 });
  h.createRate.mockResolvedValue({ id: RATE, rate: 5 });
  h.updateRate.mockResolvedValue({ id: RATE, rate: 5 });
  h.deleteRate.mockResolvedValue(undefined);
  h.toggleRate.mockResolvedValue({ id: RATE, rate: 5 });
});

describe('tax routes answer on every plan (issue 2358)', () => {
  it('a free-plan merchant can switch VAT OFF', async () => {
    const res = await request(app).put(`/stores/${STORE}/tax/settings`).send({ taxEnabled: false });
    expect(res.status).toBe(200);
    expect(h.updateSettings).toHaveBeenCalledWith(STORE, { taxEnabled: false });
  });

  it.each([
    ['get', `/stores/${STORE}/tax/settings`, 200],
    ['get', `/stores/${STORE}/tax/rates`, 200],
    ['get', `/stores/${STORE}/tax/rates/${RATE}`, 200],
    ['post', `/stores/${STORE}/tax/rates`, 201],
    ['put', `/stores/${STORE}/tax/rates/${RATE}`, 200],
    ['delete', `/stores/${STORE}/tax/rates/${RATE}`, 200],
    ['patch', `/stores/${STORE}/tax/rates/${RATE}/toggle`, 200],
  ] as const)('%s %s is not feature-gated', async (method, url, status) => {
    const res = await request(app)[method](url).send({ name: 'VAT', rate: 5 });
    expect(res.status).toBe(status);
  });
});

describe('fields the charge does not read are rejected (issue 2357)', () => {
  it.each([
    ['country', { country: 'EG' }],
    ['state', { state: 'Capital' }],
    ['priority', { priority: 2 }],
    ['isCompound', { isCompound: true }],
  ])('POST a rate with %s → 400, nothing written', async (_k, extra) => {
    const res = await request(app)
      .post(`/stores/${STORE}/tax/rates`)
      .send({ name: 'VAT', rate: 5, ...extra });
    expect(res.status).toBe(400);
    expect(h.createRate).not.toHaveBeenCalled();
  });

  it('PUT a rate with country → 400, nothing written', async () => {
    const res = await request(app)
      .put(`/stores/${STORE}/tax/rates/${RATE}`)
      .send({ country: 'SA' });
    expect(res.status).toBe(400);
    expect(h.updateRate).not.toHaveBeenCalled();
  });

  it('PUT settings with defaultTaxRate → 400, nothing written', async () => {
    const res = await request(app).put(`/stores/${STORE}/tax/settings`).send({ defaultTaxRate: 5 });
    expect(res.status).toBe(400);
    expect(h.updateSettings).not.toHaveBeenCalled();
  });

  it('a plain rate (name, nameAr, rate, isActive) is accepted', async () => {
    const res = await request(app)
      .post(`/stores/${STORE}/tax/rates`)
      .send({ name: 'VAT', nameAr: 'ضريبة القيمة المضافة', rate: 5, isActive: true });
    expect(res.status).toBe(201);
    expect(h.createRate).toHaveBeenCalledWith(STORE, {
      name: 'VAT',
      nameAr: 'ضريبة القيمة المضافة',
      rate: 5,
      isActive: true,
    });
  });
});
