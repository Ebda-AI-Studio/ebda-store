/**
 * Route-level tests for `POST /stores/:id/payment-links` (#1547, #1799).
 *
 * The merchant-initiated WhatsApp payment link creates a draft order, mints a
 * hosted-checkout URL and sends it through WBS. Nothing imported this router
 * before (#1547). The properties under test:
 *
 *   1. Every refusal answers with the platform envelope
 *      `{ success:false, error:{ code, message } }` (#1799). The flat
 *      `{ error:'CODE', message }` shape was dropped by the admin normaliser,
 *      so the merchant saw "Request failed with status 400" for an
 *      out-of-stock line, an unapproved template and a missing WBS key alike.
 *   2. The draft order is priced from the catalogue, never from the request.
 *   3. A failure AFTER the draft order exists deletes it (compensation), so a
 *      failed send never leaves an unpaid order in the merchant's list.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { mockPrisma, mockPaymentService, mockIsFeatureEnabled, mockAuditLog, mockOrderGate } =
  vi.hoisted(() => ({
    mockOrderGate: vi.fn(),
    mockPrisma: {
      store: { findUnique: vi.fn() },
      whatsAppTemplate: { findUnique: vi.fn() },
      product: { findMany: vi.fn() },
      user: { findFirst: vi.fn(), create: vi.fn() },
      order: { create: vi.fn(), delete: vi.fn() },
    },
    mockPaymentService: { getDefaultProvider: vi.fn(), createPayment: vi.fn() },
    mockIsFeatureEnabled: vi.fn(),
    mockAuditLog: vi.fn(),
  }));

// Money batch B: fiscal documents + the frozen COD fee are covered end-to-end
// by tests/integration/fiscal-documents.test.ts; this unit suite stubs them.
vi.mock('@api/lib/order-tax', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/order-tax')>()),
  // A store that does not collect VAT (the gate is tested in vat-gate tests).
  resolveActiveTaxRate: vi
    .fn()
    .mockResolvedValue({ ratePercent: 0, includedInPrice: false, seller: null }),
}));
vi.mock('@api/services/fiscal-document.service', () => ({
  FiscalDocumentService: {
    issueSaleDocument: vi.fn().mockResolvedValue(null),
    cancelSaleDocument: vi.fn().mockResolvedValue(null),
    issueRefundDocument: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@api/services/payment-providers/cod.provider', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/services/payment-providers/cod.provider')>()),
  loadCodFeeConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('@force/database', () => ({
  prisma: mockPrisma,
  // The route runs inside the request's tenant transaction in production.
  hasTenantContext: () => true,
  withMoneyTx: (_p: unknown, fn: (tx: unknown) => unknown) => fn(mockPrisma),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: mockAuditLog,
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: mockPaymentService,
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: mockIsFeatureEnabled },
}));
vi.mock('@api/services/plan-limit.service', () => ({ assertOrderAllowed: mockOrderGate }));
vi.mock('@api/services/encryption.service', () => ({
  encryption: { decrypt: (v: string) => `plain(${v})` },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const URL = `/stores/${STORE_ID}/payment-links`;

const STORE = {
  id: STORE_ID,
  name: 'Shop',
  nameAr: 'متجر',
  domain: 'shop.example',
  slug: 'shop',
  currency: 'EGP',
  wbsEnabled: true,
  credentials: { wbsApiKey: 'enc-key' },
};
const PRODUCT = {
  id: PRODUCT_ID,
  name: 'Dates Box',
  price: 4500,
  sku: 'DB-1',
  costPrice: 2000,
  inventory: 10,
  trackInventory: true,
  allowBackorder: false,
  variants: [],
};
const BODY = { customerPhone: '+96512345678', items: [{ productId: PRODUCT_ID, quantity: 2 }] };

let app: Express;
const fetchMock = vi.fn();

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
  const { default: router } = await import('@api/routes/payment-links.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores/:id/payment-links', router);
  app.use(errorHandler);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.store.findUnique.mockResolvedValue(STORE);
  mockPrisma.whatsAppTemplate.findUnique.mockResolvedValue({
    metaName: 'payment_link_v2',
    status: 'approved',
  });
  mockPrisma.product.findMany.mockResolvedValue([PRODUCT]);
  mockPrisma.user.findFirst.mockResolvedValue({
    id: 'cust-1',
    firstName: 'Sara',
    lastName: 'A',
    email: 'sara@example.com',
  });
  mockPrisma.order.create.mockImplementation(async ({ data }: any) => ({
    id: 'order-1',
    orderNumber: data.orderNumber,
    total: data.total,
    currency: data.currency,
    items: data.items.create.map((i: any, n: number) => ({ id: `oi-${n}`, ...i })),
  }));
  mockPrisma.order.delete.mockResolvedValue({});
  mockOrderGate.mockResolvedValue(undefined);
  mockIsFeatureEnabled.mockResolvedValue(false);
  mockPaymentService.getDefaultProvider.mockResolvedValue('paymob');
  mockPaymentService.createPayment.mockResolvedValue({
    paymentUrl: 'https://pay.example/inv-1',
    invoiceId: 'inv-1',
  });
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, messageId: 'wamid-1' }),
  });
});

function expectEnvelope(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.body.success).toBe(false);
  // The admin normaliser reads error.code / error.message — a string `error`
  // is exactly what it could not read (#1799).
  expect(typeof res.body.error).toBe('object');
  expect(res.body.error.code).toBe(code);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.message.length).toBeGreaterThan(0);
}

describe('POST /stores/:id/payment-links', () => {
  it('happy path: prices the draft order from the catalogue and sends the link via WBS', async () => {
    const res = await request(app)
      .post(URL)
      .send({ ...BODY, items: [{ productId: PRODUCT_ID, quantity: 2, price: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      paymentUrl: 'https://pay.example/inv-1',
      orderId: 'order-1',
      totalFils: 9000,
      messageId: 'wamid-1',
    });
    const created = mockPrisma.order.create.mock.calls[0][0].data;
    expect(created.total).toBe(9000);
    expect(created.items.create[0]).toMatchObject({ price: 4500, total: 9000, quantity: 2 });
    expect(mockPaymentService.createPayment.mock.calls[0][0].amount).toBe(9000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockPrisma.order.delete).not.toHaveBeenCalled();
  });

  it('order-cap gate: a store past its cap + grace gets 402 and NO customer/order row is written', async () => {
    const { AppError } = await import('@api/middleware/error-handler');
    mockOrderGate.mockRejectedValueOnce(
      new AppError(402, 'PLAN_LIMIT_REACHED', 'cap', { limitKey: 'maxOrdersPerMonth' })
    );
    const res = await request(app).post(URL).send(BODY);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(mockOrderGate).toHaveBeenCalledWith(STORE_ID);
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('INVALID_BODY carries the validation issues under error.details', async () => {
    const res = await request(app).post(URL).send({ customerPhone: '12345' });
    expectEnvelope(res, 400, 'INVALID_BODY');
    expect(res.body.error.details).toBeDefined();
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
  });

  it('WBS_NOT_CONFIGURED when the store has no WBS key', async () => {
    mockPrisma.store.findUnique.mockResolvedValue({ ...STORE, credentials: null });
    expectEnvelope(await request(app).post(URL).send(BODY), 400, 'WBS_NOT_CONFIGURED');
  });

  it('TEMPLATE_NOT_APPROVED names the template status', async () => {
    mockPrisma.whatsAppTemplate.findUnique.mockResolvedValue({ metaName: 'x', status: 'pending' });
    const res = await request(app).post(URL).send(BODY);
    expectEnvelope(res, 400, 'TEMPLATE_NOT_APPROVED');
    expect(res.body.error.details).toEqual({ templateStatus: 'pending' });
  });

  it('PRODUCT_NOT_FOUND for a product outside this store', async () => {
    mockPrisma.product.findMany.mockResolvedValue([]);
    const res = await request(app).post(URL).send(BODY);
    expectEnvelope(res, 400, 'PRODUCT_NOT_FOUND');
    expect(res.body.error.details).toEqual({ productId: PRODUCT_ID });
  });

  it('OUT_OF_STOCK names the product and creates no order', async () => {
    mockPrisma.product.findMany.mockResolvedValue([{ ...PRODUCT, inventory: 1 }]);
    const res = await request(app).post(URL).send(BODY);
    expectEnvelope(res, 400, 'OUT_OF_STOCK');
    expect(res.body.error.message).toContain('Dates Box');
    expect(res.body.error.details).toMatchObject({ productName: 'Dates Box' });
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
  });

  it('PAYMENT_NOT_CONFIGURED deletes the draft order it already created', async () => {
    mockPaymentService.getDefaultProvider.mockResolvedValue(null);
    expectEnvelope(await request(app).post(URL).send(BODY), 400, 'PAYMENT_NOT_CONFIGURED');
    expect(mockPrisma.order.delete).toHaveBeenCalledWith({
      where: { id: 'order-1', storeId: STORE_ID },
    });
  });

  it('WBS_SEND_FAILED deletes the draft order and keeps the bridge code as a detail', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ success: false, error: 'RECIPIENT_BLOCKED', message: 'Blocked' }),
    });
    const res = await request(app).post(URL).send(BODY);
    expectEnvelope(res, 502, 'WBS_SEND_FAILED');
    expect(res.body.error.message).toBe('Blocked');
    expect(res.body.error.details).toEqual({ wbsError: 'RECIPIENT_BLOCKED' });
    expect(mockPrisma.order.delete).toHaveBeenCalledWith({
      where: { id: 'order-1', storeId: STORE_ID },
    });
  });

  it('a throw from the payment provider deletes the draft order and reaches the error handler', async () => {
    mockPaymentService.createPayment.mockRejectedValue(new Error('gateway down'));
    const res = await request(app).post(URL).send(BODY);
    expect(res.status).toBe(500);
    expect(mockPrisma.order.delete).toHaveBeenCalledWith({
      where: { id: 'order-1', storeId: STORE_ID },
    });
  });
});

describe('admin paymentLinkErrorMessage', () => {
  it('maps a known code to translated copy with the product name, else falls back', async () => {
    const { paymentLinkErrorMessage } =
      await import('../../apps/admin/src/components/whatsapp/payment-link-errors');
    const t = (key: string, values?: Record<string, string>) =>
      `${key}${values?.name ? `:${values.name}` : ''}`;
    expect(
      paymentLinkErrorMessage(
        { code: 'OUT_OF_STOCK', message: 'x', details: { productName: 'Dates Box' } },
        t
      )
    ).toBe('errOutOfStock:Dates Box');
    expect(paymentLinkErrorMessage({ code: 'SOMETHING_NEW', message: 'Server says' }, t)).toBe(
      'Server says'
    );
    expect(paymentLinkErrorMessage({ code: 'SERVER_ERROR', message: '' }, t)).toBe(
      'toastUnknownError'
    );
  });

  it('every mapped key exists in BOTH the en and ar message catalogues', async () => {
    const { PAYMENT_LINK_ERROR_KEYS } =
      await import('../../apps/admin/src/components/whatsapp/payment-link-errors');
    const en = (await import('../../apps/admin/src/i18n/messages/en.json')).default as any;
    const ar = (await import('../../apps/admin/src/i18n/messages/ar.json')).default as any;
    for (const key of Object.values(PAYMENT_LINK_ERROR_KEYS)) {
      expect(en.whatsappIntegration.paymentLink[key], `en ${key}`).toBeTruthy();
      expect(ar.whatsappIntegration.paymentLink[key], `ar ${key}`).toBeTruthy();
    }
  });
});
