/**
 * Tax archive: full receipt + richer lists (Ahmad 2026-11-15).
 *
 *  - the receipt renders EVERY field a full v2 payload carries (seller branch/activity/POS, TRN, per-line VAT,
 *    item codes, payment, totals, currency, ETA uuid + QR link) in Arabic and English;
 *  - an old v1 payload degrades with "not recorded at issue" instead of blank cells or a crash;
 *  - per-line VAT shares always sum to the order VAT;
 *  - the super-admin list endpoints return the new fields, filters and a keyset cursor, and never a full phone/email.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => {
  const db = {
    fiscalDocument: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    order: { findMany: vi.fn() },
    etaReceipt: { findMany: vi.fn() },
    storeTaxProfile: { findFirst: vi.fn() },
    etaConnection: { findFirst: vi.fn() },
  };
  return { db, eta: vi.fn() };
});

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'super_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/lib/repo-factory', () => ({ storeDb: async () => h.db }));
vi.mock('@api/lib/platform-hub', () => ({
  hubOnD1: async () => true,
  hubFanoutStoreIds: async () => ({ ids: [STORE], truncated: false }),
  hubStoresById: async () => [{ id: STORE, name: 'Pecan Bee' }],
  hubFanout: async (ids: string[], fn: (id: string) => Promise<unknown>) =>
    Promise.all(ids.map(async id => ({ storeId: id, value: await fn(id) }))),
}));
vi.mock('@api/lib/definer', () => ({ fiscalArchive: vi.fn(), fiscalArchiveStores: vi.fn() }));
vi.mock('@api/services/eta-receipt.service', () => ({
  EtaReceiptService: { listForOrder: h.eta },
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  withUser: (_u: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { renderFiscalDocumentHtml } from '@api/services/fiscal-document-render';
import { allocateLineVat } from '@api/services/fiscal-document-lines';
import { maskContact, pageFiscalRows, pickEtaReceipt } from '@api/services/fiscal-document-list';
import { fiscalArchiveRoutes } from '@api/routes/fiscal-document.routes';

const STORE = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const PHONE = '+201012345678';

const V2_PAYLOAD = {
  version: 2,
  orderNumber: 'ORD-9001',
  orderDate: '2026-11-01T10:00:00.000Z',
  currency: 'EGP',
  isTaxInvoice: true,
  seller: {
    name: 'Pecan Bee',
    legalName: 'Pecan Bee LLC',
    trn: '123456789',
    address: '5 Nile St, Cairo',
    phone: '+20233334444',
    email: 'hello@pecanbee.example',
    branchCode: 'BR-0',
    activityCode: '4719',
    posSerial: 'POS-77',
    branchAddress: { governate: 'Cairo', street: 'Nile St' },
  },
  buyer: { name: 'Mona Adel', addressAr: ['مدينة نصر'], addressEn: ['Nasr City'] },
  lines: [
    {
      kind: 'item',
      description: 'Honey jar',
      descriptionAr: 'برطمان عسل',
      sku: 'HNY-1',
      quantity: 2,
      unitPrice: 5000,
      amount: 10000,
      vatRateBps: 1400,
      vatAmount: 1228,
      internalCode: 'HNY-1',
      etaItemType: 'EGS',
      etaItemCode: 'EG-123456789-HONEY',
    },
    {
      kind: 'shipping',
      description: 'Shipping',
      descriptionAr: 'الشحن',
      quantity: 1,
      unitPrice: 2000,
      amount: 2000,
      vatRateBps: 1400,
      vatAmount: 246,
    },
  ],
  discounts: [{ kind: 'coupon', label: 'SAVE10', amount: 1000 }],
  totals: {
    subtotal: 10000,
    discount: 1000,
    shipping: 2000,
    codFee: 500,
    extra: 0,
    taxable: 9649,
    vat: 1351,
    vatRateBps: 1400,
    taxIncludedInPrice: false,
    total: 11000,
  },
  paymentMethod: 'cod',
  paymentStatus: 'unpaid',
};

const doc = (payload: unknown, over: Record<string, unknown> = {}) => ({
  docType: 'tax_invoice',
  number: 'INV-000042',
  status: 'issued',
  issuedAt: '2026-11-01T10:30:00.000Z',
  currency: 'EGP',
  netAmount: 9649,
  vatAmount: 1351,
  totalAmount: 11000,
  vatRateBps: 1400,
  sellerTrn: '123456789',
  payload,
  ...over,
});

const ETA = {
  status: 'accepted',
  uuid: 'abc123uuid',
  longId: 'LONG-ID-9',
  receiptNumber: 'ORD-9001',
  environment: 'prod',
  qr: 'https://invoicing.eta.gov.eg/receipts/search/abc123uuid/share/2026-11-01T10:30:00Z#Total:110,IssuerRIN:123456789',
  qrSvg: '<svg data-qr="1"></svg>',
};

describe('allocateLineVat', () => {
  it('shares sum to the order VAT exactly, remainder on the last non-zero line', () => {
    const out = allocateLineVat(
      [{ amount: 3333 }, { amount: 3333 }, { amount: 3334 }, { amount: 0 }],
      1400,
      1400
    );
    expect(out.map(o => o.vatAmount).reduce((a, b) => a + b, 0)).toBe(1400);
    expect(out[3].vatAmount).toBe(0);
  });
  it('is all zero without VAT', () => {
    expect(allocateLineVat([{ amount: 100 }], 0, null)).toEqual([
      { vatRateBps: null, vatAmount: 0 },
    ]);
  });
});

describe('receipt rendering', () => {
  const needles = [
    'Pecan Bee LLC',
    '123456789',
    'BR-0',
    '4719',
    'POS-77',
    '5 Nile St, Cairo',
    'Nile St',
    'hello@pecanbee.example',
    'INV-000042',
    'ORD-9001',
    'EGP',
    'Mona Adel',
    'Nasr City',
    'Honey jar',
    'HNY-1',
    'EG-123456789-HONEY',
    '14%',
    'SAVE10',
    'Cash on delivery',
    'Unpaid',
    'abc123uuid',
    'LONG-ID-9',
    'data-qr="1"',
    'invoicing.eta.gov.eg/receipts/search',
  ].filter(Boolean);

  it('renders every field of a full v2 payload (English)', () => {
    const html = renderFiscalDocumentHtml(doc(V2_PAYLOAD) as any, 'en', 'Africa/Cairo', ETA);
    for (const n of needles) expect(html, n).toContain(n);
    // line VAT amounts, shipping + COD fee in the totals block
    expect(html).toContain('12.28');
    expect(html).toContain('2.46');
    expect(html).toContain('Cash on delivery fee'); // totals block: COD fee row
    expect(html).toContain('Shipping');
    expect(html).not.toContain('data-not-recorded');
    expect(html).toContain('lang="en"');
  });

  it('renders the Arabic receipt RTL with Arabic labels', () => {
    const html = renderFiscalDocumentHtml(doc(V2_PAYLOAD) as any, 'ar', 'Africa/Cairo', ETA);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('برطمان عسل');
    expect(html).toContain('الدفع عند الاستلام');
    expect(html).toContain('كود الفرع');
    expect(html).toContain('مقبول من المصلحة');
    expect(html).toContain('abc123uuid');
  });

  it('degrades an old v1 payload: "not recorded at issue", never a crash', () => {
    const v1 = {
      version: 1,
      orderNumber: 'ORD-1',
      currency: 'EGP',
      isTaxInvoice: true,
      seller: {
        name: 'Old Shop',
        legalName: null,
        trn: '5',
        address: null,
        phone: null,
        email: null,
      },
      buyer: { name: '', addressAr: [], addressEn: [] },
      lines: [{ kind: 'item', description: 'Thing', quantity: 1, unitPrice: 100, amount: 100 }],
      discounts: [],
      totals: {
        subtotal: 100,
        discount: 0,
        shipping: 0,
        codFee: 0,
        extra: 0,
        taxable: 100,
        vat: 0,
        vatRateBps: null,
        taxIncludedInPrice: false,
        total: 100,
      },
      paymentMethod: 'instapay',
    };
    const html = renderFiscalDocumentHtml(doc(v1, { sellerTrn: '5' }) as any, 'en');
    expect(html).toContain('Not recorded at issue');
    // branch, activity, line rate, line vat, payment status
    expect((html.match(/data-not-recorded/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('InstaPay');
    expect(html).toContain('No e-receipt was submitted');
  });

  it('escapes user text', () => {
    const p = {
      ...V2_PAYLOAD,
      buyer: { name: '<script>x</script>', addressAr: [], addressEn: [] },
    };
    expect(renderFiscalDocumentHtml(doc(p) as any, 'en')).not.toContain('<script>x');
  });

  it('never prints a non-https verification link', () => {
    const html = renderFiscalDocumentHtml(doc(V2_PAYLOAD) as any, 'en', 'Africa/Cairo', {
      ...ETA,
      qr: 'javascript:alert(1)',
    });
    expect(html).not.toContain('javascript:');
  });
});

describe('list helpers', () => {
  it('masks contacts', () => {
    expect(maskContact(PHONE)).toBe('•••••678');
    expect(maskContact('mona@example.test')).toBe('m•••@example.test');
    expect(maskContact(undefined)).toBeNull();
  });

  it('matches refund documents to their return receipt only', () => {
    const rs = [
      { kind: 'sale', seq: 1, refundKey: null },
      { kind: 'return', seq: 1, refundKey: 'full' },
      { kind: 'return', seq: 1, refundKey: 'ret-1' },
    ];
    expect(pickEtaReceipt({ docType: 'tax_invoice' }, rs)).toBe(rs[0]);
    expect(pickEtaReceipt({ docType: 'credit_note', refundRef: 'ret-1' }, rs)).toBe(rs[2]);
    expect(pickEtaReceipt({ docType: 'credit_note', refundRef: 'order:o:full' }, rs)).toBe(rs[1]);
    expect(pickEtaReceipt({ docType: 'refund_receipt', refundRef: 'zzz' }, rs)).toBeNull();
  });

  it('pages in memory with a keyset cursor and filters', async () => {
    h.db.order.findMany.mockResolvedValue([]);
    h.db.etaReceipt.findMany.mockResolvedValue([]);
    const mk = (i: number, docType = 'receipt') => ({
      id: `id-${i}`,
      orderId: null,
      docType,
      number: `RCT-00000${i}`,
      status: 'issued',
      issuedAt: new Date(Date.UTC(2026, 10, i)),
      cancelledAt: null,
      originalNumber: null,
      netAmount: 1,
      vatAmount: 0,
      totalAmount: 1,
      currency: 'EGP',
      payload: { orderNumber: `ORD-${i}` },
    });
    const all = [mk(1), mk(2), mk(3, 'credit_note'), mk(4), mk(5)];
    const p1 = await pageFiscalRows(STORE, all, { limit: 2 });
    expect(p1.documents.map(d => d.id)).toEqual(['id-5', 'id-4']);
    const p2 = await pageFiscalRows(STORE, all, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.documents.map(d => d.id)).toEqual(['id-3', 'id-2']);
    const only = await pageFiscalRows(STORE, all, { docType: 'credit_note' });
    expect(only.documents.map(d => d.id)).toEqual(['id-3']);
    const range = await pageFiscalRows(STORE, all, {
      from: new Date(Date.UTC(2026, 10, 2)),
      to: new Date(Date.UTC(2026, 10, 4)),
    });
    expect(range.documents.map(d => d.id)).toEqual(['id-4', 'id-3', 'id-2']);
    const byOrder = await pageFiscalRows(STORE, all, { q: 'ord-4' });
    expect(byOrder.documents.map(d => d.id)).toEqual(['id-4']);
  });
});

describe('super-admin archive endpoints', () => {
  const app = express();
  app.use('/admin', fiscalArchiveRoutes);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err.status ?? 500).json({ error: String(err.message) })
  );

  const row = {
    id: '33333333-3333-4333-8333-333333333333',
    orderId: ORDER,
    docType: 'receipt',
    number: 'RCT-000007',
    status: 'issued',
    issuedAt: new Date('2026-11-02T09:00:00Z'),
    cancelledAt: null,
    originalNumber: null,
    netAmount: 1000,
    vatAmount: 140,
    totalAmount: 1140,
    currency: 'EGP',
    refundRef: null,
    payload: { orderNumber: 'ORD-9001', paymentMethod: 'cod', paymentStatus: null },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.db.order.findMany.mockResolvedValue([
      {
        id: ORDER,
        paymentStatus: 'paid',
        shippingAddress: {
          firstName: 'Mona',
          lastName: 'Adel',
          phone: PHONE,
          email: 'mona@example.test',
        },
      },
    ]);
    h.db.etaReceipt.findMany.mockResolvedValue([
      {
        orderId: ORDER,
        kind: 'sale',
        seq: 1,
        refundKey: null,
        status: 'accepted',
        uuid: 'uuid-xyz',
      },
    ]);
  });

  it('lists documents with customer, payment, ETA, filters passed to the DB and a keyset cursor', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...row,
      id: `00000000-0000-4000-8000-00000000000${i}`,
    }));
    h.db.fiscalDocument.findMany.mockResolvedValue(rows);
    const res = await request(app).get(
      `/admin/fiscal-archive/${STORE}?limit=2&docType=receipt&q=rct-7&from=2026-11-01T00:00:00.000Z&to=2026-11-30T23:59:59.999Z&cursor=44444444-4444-4444-8444-444444444444`
    );
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.documents).toHaveLength(2);
    expect(d.nextCursor).toBe(rows[1].id);
    expect(d.documents[0]).toMatchObject({
      customerName: 'Mona Adel',
      contactMasked: '•••••678',
      paymentMethod: 'cod',
      paymentStatus: 'paid',
      etaStatus: 'accepted',
      etaUuid: 'uuid-xyz',
      currency: 'EGP',
      orderNumber: 'ORD-9001',
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PHONE);
    expect(body).not.toContain('mona@example.test');
    const args = h.db.fiscalDocument.findMany.mock.calls[0][0];
    expect(args.take).toBe(3);
    expect(args.cursor).toEqual({ id: '44444444-4444-4444-8444-444444444444' });
    expect(args.skip).toBe(1);
    expect(args.orderBy).toEqual([{ issuedAt: 'desc' }, { id: 'desc' }]);
    expect(args.where.docType).toBe('receipt');
    expect(args.where.issuedAt.gte).toBeInstanceOf(Date);
    expect(args.where.issuedAt.lte).toBeInstanceOf(Date);
    expect(args.where.OR[0]).toEqual({ number: { contains: 'RCT-7' } });
    expect(args.select.payload).toBe(true);
    expect(args.select.id).toBe(true);
  });

  it('adds the store card to a list call with summary=1', async () => {
    h.db.fiscalDocument.findMany.mockResolvedValue([row]);
    h.db.fiscalDocument.count.mockResolvedValue(1);
    h.db.fiscalDocument.findFirst.mockResolvedValue(null);
    h.db.fiscalDocument.aggregate.mockResolvedValue({
      _sum: { netAmount: null, vatAmount: null, totalAmount: null },
      _count: { _all: 0 },
    });
    h.db.storeTaxProfile.findFirst.mockResolvedValue(null);
    h.db.etaConnection.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/admin/fiscal-archive/${STORE}?limit=1&summary=1`);
    expect(res.body.data.summary).toMatchObject({
      trnPresent: false,
      etaConnected: false,
      period: { gross: 0, count: 0 },
    });
    const plain = await request(app).get(`/admin/fiscal-archive/${STORE}`);
    expect('summary' in plain.body.data).toBe(false);
  });

  it('never uses an offset when there is no cursor', async () => {
    h.db.fiscalDocument.findMany.mockResolvedValue([row]);
    await request(app).get(`/admin/fiscal-archive/${STORE}`);
    const args = h.db.fiscalDocument.findMany.mock.calls[0][0];
    expect('skip' in args).toBe(false);
  });

  it('lists stores with count, last number, period totals and tax / ETA status', async () => {
    h.db.fiscalDocument.count.mockResolvedValue(12);
    h.db.fiscalDocument.findFirst.mockImplementation(async (a: any) =>
      a.where.sellerTrn
        ? { id: 'x' }
        : { issuedAt: new Date('2026-11-05T00:00:00Z'), number: 'INV-000012' }
    );
    h.db.fiscalDocument.aggregate.mockResolvedValue({
      _sum: { netAmount: 800, vatAmount: 112, totalAmount: 912 },
      _count: { _all: 3 },
    });
    h.db.storeTaxProfile.findFirst.mockResolvedValue({
      status: 'verified',
      taxRegistrationNumber: '123456789',
    });
    h.db.etaConnection.findFirst.mockResolvedValue({ enabled: true, environment: 'prod' });
    const res = await request(app).get(
      '/admin/fiscal-archive?from=2026-11-01T00:00:00.000Z&to=2026-11-30T00:00:00.000Z'
    );
    expect(res.status).toBe(200);
    const s = res.body.data.stores[0];
    expect(s).toMatchObject({ storeId: STORE, storeName: 'Pecan Bee', documentCount: 12 });
    expect(s.summary).toMatchObject({
      documentCount: 12,
      lastNumber: 'INV-000012',
      trnPresent: true,
      taxProfileStatus: 'verified',
      etaConnected: true,
      etaEnabled: true,
      etaEnvironment: 'prod',
      period: { net: 800, vat: 112, gross: 912, count: 3 },
    });
    const agg = h.db.fiscalDocument.aggregate.mock.calls[0][0];
    expect(agg.where.docType.in).toEqual(['tax_invoice', 'receipt']);
    expect(agg.where.status).toBe('issued');
    expect(agg.where.issuedAt.gte.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('issuing a v2 sale document', () => {
  it('stamps payload v2: ETA branch/activity/POS, per-line VAT summing to the order VAT, EGS code, payment status', async () => {
    const { FiscalDocumentService } = await import('@api/services/fiscal-document.service');
    const order = {
      id: ORDER,
      orderNumber: 'ORD-5',
      createdAt: new Date('2026-11-01T00:00:00Z'),
      currency: 'EGP',
      sellerTaxRegistrationNumber: '123456789',
      sellerTaxLegalName: 'Pecan Bee LLC',
      subtotal: 10000,
      discount: 0,
      couponDiscount: 0,
      couponCode: null,
      promotionDiscount: 0,
      loyaltyDiscount: 0,
      loyaltyPointsRedeemed: null,
      shipping: 2000,
      codFee: 0,
      extraAmount: 0,
      extraAmountNote: null,
      appliedPromotion: null,
      tax: 1680,
      taxRateBps: 1400,
      taxIncludedInPrice: false,
      taxableAmount: 12000,
      total: 13680,
      paymentStatus: 'unpaid',
      shippingAddress: { firstName: 'Mona', lastName: 'Adel' },
      billingAddress: null,
      payments: [{ provider: 'cod', method: null }],
      items: [
        {
          id: 'i1',
          productId: 'p1',
          productName: 'Honey',
          variantName: null,
          sku: 'HNY-1',
          quantity: 2,
          price: 5000,
          total: 10000,
          bundleId: null,
          product: { nameAr: 'عسل' },
        },
      ],
    };
    let created: any;
    const tx: any = {
      fiscalDocument: { findFirst: async () => null, create: async (a: any) => (created = a.data) },
      order: { findFirst: async () => order },
      store: {
        findUnique: async () => ({ name: 'Pecan Bee', address: 'Cairo', phone: null, email: null }),
      },
      $queryRaw: async () => [{ last_serial: 1 }],
    };
    // etaConnection is read through storeDb (it is DO-writable config), not through the money transaction.
    h.db.etaConnection.findFirst.mockResolvedValue({
      branchCode: 'BR-0',
      activityCode: '4719',
      posSerial: 'POS-77',
      defaultItemCode: 'EG-1-HONEY',
      address: { governate: 'Cairo' },
    });
    await FiscalDocumentService.issueSaleDocument(tx, STORE, ORDER);
    const p = created.payload;
    expect(p.version).toBe(2);
    expect(p.seller).toMatchObject({
      branchCode: 'BR-0',
      activityCode: '4719',
      posSerial: 'POS-77',
      branchAddress: { governate: 'Cairo' },
    });
    expect(p.paymentStatus).toBe('unpaid');
    expect(p.lines.reduce((n: number, l: any) => n + l.vatAmount, 0)).toBe(1680);
    expect(p.lines[0]).toMatchObject({
      internalCode: 'HNY-1',
      etaItemType: 'EGS',
      etaItemCode: 'EG-1-HONEY',
      vatRateBps: 1400,
    });
    expect(p.lines[1].etaItemCode).toBeNull(); // shipping line has no item code
  });
});
