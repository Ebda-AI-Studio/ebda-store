/**
 * Sibling surfaces of the product "an emptied text field must clear" defect.
 *
 * The product edit page was the reported sample; the same three-layer mistake
 * (Zod rejects `null` → the merchant's clear 400s or is dropped) was present
 * on every other admin form that reuses ONE body for both POST (create) and
 * PUT (update): store locations, tax rates and coupons. Categories and
 * warehouses already accepted `null` server-side — only their admin callers
 * were wrong, and those are covered by
 * apps/admin/src/lib/__tests__/form-text.test.ts.
 *
 * The convention throughout: `null` clears, `undefined` (omitted key) leaves
 * the stored value alone.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
// Imported from SOURCE, not from the package entry point: `@ebda/shared`
// resolves to packages/shared/DIST, so a schema test written against it
// passes on the last build instead of on the code under review.
import { locationInputSchema } from '@shared/src/schemas/location';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    coupon: { findFirst: vi.fn(), update: vi.fn() },
    taxRate: { findFirst: vi.fn(), update: vi.fn() },
    supplier: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
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
  // coupons/validate runs optionalAuthenticate (issue 2066): no token = guest.
  optionalAuthenticate: (_req: any, _res: any, next: any) => next(),
  customerUserId: () => undefined,
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn(),
  couponValidateLimiter: (_req: any, _res: any, next: any) => next(),
  couponValidateDistinctLimiter: (_req: any, _res: any, next: any) => next(),
  publicTenantLimiter: (_req: any, _res: any, next: any) => next(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
  adminReadLimiter: (_req: any, _res: any, next: any) => next(),
  // tax.routes.ts mounts the VAT-evidence upload behind these (ruling TAX-4).
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  dailyUploadLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const STORE_ID = '11111111-1111-1111-1111-111111111111';

// ─── Locations — packages/shared/src/schemas/location.ts ─────────────────────

describe('locationInputSchema — an emptied branch field can clear', () => {
  const updateSchema = locationInputSchema.partial();

  const NULLABLE_FIELDS = [
    'nameAr',
    'countryAr',
    'addressAr',
    'phone',
    'whatsapp',
    'hours',
    'hoursAr',
  ] as const;

  for (const field of NULLABLE_FIELDS) {
    it(`accepts null for ${field} (rejected before the fix)`, () => {
      const parsed = updateSchema.parse({ [field]: null });
      expect(parsed[field]).toBeNull();
    });
  }

  it('accepts null for the maps URLs and normalises an empty string to null', () => {
    expect(updateSchema.parse({ mapsUrl: null }).mapsUrl).toBeNull();
    expect(updateSchema.parse({ mapsEmbedUrl: '' }).mapsEmbedUrl).toBeNull();
  });

  it('still accepts a real https maps URL unchanged', () => {
    const url = 'https://maps.google.com/?q=Salmiya';
    expect(updateSchema.parse({ mapsUrl: url }).mapsUrl).toBe(url);
  });

  it('leaves an omitted key absent — never a null the caller did not send', () => {
    const parsed = updateSchema.parse({ name: 'Salmiya Branch' });
    expect('phone' in parsed).toBe(false);
    expect(parsed.phone).toBeUndefined();
  });

  it('still rejects null for the required columns', () => {
    expect(() => updateSchema.parse({ name: null })).toThrow();
    expect(() => updateSchema.parse({ country: null })).toThrow();
    expect(() => updateSchema.parse({ address: null })).toThrow();
  });
});

// ─── Coupons — apps/api/src/routes/coupon.routes.ts ──────────────────────────

describe('PUT /stores/:storeId/coupons/:id — an emptied coupon field clears', () => {
  let app: Express;

  beforeAll(async () => {
    const { default: couponRouter } = await import('@api/routes/coupon.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores', couponRouter);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.coupon.findFirst.mockResolvedValue({
      id: 'coupon-1',
      code: 'VIP10',
      nameAr: 'خصم',
      description: 'Ten percent off everything',
      descriptionAr: 'وصف',
    });
    mockPrisma.coupon.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'coupon-1', ...data })
    );
  });

  for (const field of ['nameAr', 'description', 'descriptionAr'] as const) {
    it(`accepts null for ${field} and writes null`, async () => {
      const res = await request(app)
        .put(`/api/v1/stores/${STORE_ID}/coupons/coupon-1`)
        .send({ [field]: null });

      expect(res.status).toBe(200);
      expect(mockPrisma.coupon.update.mock.calls[0][0].data[field]).toBeNull();
    });
  }

  it('leaves the stored text alone when the key is omitted', async () => {
    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/coupons/coupon-1`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(mockPrisma.coupon.update.mock.calls[0][0].data.description).toBeUndefined();
  });

  // ── CLEAR-1: limits/dates (min order, max discount, usage limits) ─────────
  //
  // useCoupons.ts sent `formData.minOrderAmount ? ... : undefined` for these
  // six fields, so a merchant who cleared an already-set minimum/cap/limit/
  // date had the restriction silently survive the save — the numeric/date
  // shape of the same bug the text fields above were fixed for.
  const NUMERIC_FIELDS = [
    ['minOrderAmount', 5000],
    ['maxDiscount', 2000],
    ['usageLimit', 10],
    ['usageLimitPerUser', 2],
  ] as const;

  for (const [field, value] of NUMERIC_FIELDS) {
    describe(field, () => {
      it('accepts null and writes null (clears the restriction)', async () => {
        const res = await request(app)
          .put(`/api/v1/stores/${STORE_ID}/coupons/coupon-1`)
          .send({ [field]: null });

        expect(res.status).toBe(200);
        expect(mockPrisma.coupon.update.mock.calls[0][0].data[field]).toBeNull();
      });

      it('sets a real value exactly as sent', async () => {
        const res = await request(app)
          .put(`/api/v1/stores/${STORE_ID}/coupons/coupon-1`)
          .send({ [field]: value });

        expect(res.status).toBe(200);
        expect(mockPrisma.coupon.update.mock.calls[0][0].data[field]).toBe(value);
      });

      it('leaves the stored value untouched when the key is omitted', async () => {
        const res = await request(app)
          .put(`/api/v1/stores/${STORE_ID}/coupons/coupon-1`)
          .send({ isActive: false });

        expect(res.status).toBe(200);
        expect(mockPrisma.coupon.update.mock.calls[0][0].data[field]).toBeUndefined();
      });
    });
  }

  const SAMPLE_ISO = '2026-12-01T00:00:00.000Z';

  for (const field of ['startsAt', 'expiresAt'] as const) {
    describe(field, () => {
      it('accepts null and writes null — the date-transform trap', async () => {
        // Before the fix, `.transform(s => (s ? new Date(s) : undefined))`
        // dropped an explicit null to undefined here, so the clear silently
        // no-opped instead of reaching Prisma.
        const res = await request(app)
          .put(`/api/v1/stores/${STORE_ID}/coupons/coupon-1`)
          .send({ [field]: null });

        expect(res.status).toBe(200);
        expect(mockPrisma.coupon.update.mock.calls[0][0].data[field]).toBeNull();
      });

      it('sets a real ISO value, transformed to a Date', async () => {
        const res = await request(app)
          .put(`/api/v1/stores/${STORE_ID}/coupons/coupon-1`)
          .send({ [field]: SAMPLE_ISO });

        expect(res.status).toBe(200);
        const written = mockPrisma.coupon.update.mock.calls[0][0].data[field];
        expect(written).toBeInstanceOf(Date);
        expect(written.toISOString()).toBe(SAMPLE_ISO);
      });

      it('leaves the stored value untouched when the key is omitted', async () => {
        const res = await request(app)
          .put(`/api/v1/stores/${STORE_ID}/coupons/coupon-1`)
          .send({ isActive: false });

        expect(res.status).toBe(200);
        expect(mockPrisma.coupon.update.mock.calls[0][0].data[field]).toBeUndefined();
      });
    });
  }
});

// ─── Tax rates — apps/api/src/routes/tax.routes.ts ───────────────────────────

describe('PUT /stores/:storeId/tax/rates/:id — an emptied tax-rate field clears', () => {
  let app: Express;

  beforeAll(async () => {
    const { default: taxRouter } = await import('@api/routes/tax.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores', taxRouter);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.taxRate.findFirst.mockResolvedValue({
      id: 'rate-1',
      name: 'VAT',
      nameAr: 'ضريبة',
      rate: 5,
      country: 'EG',
      state: 'Hawally',
    });
    mockPrisma.taxRate.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'rate-1', rate: 5, ...data })
    );
  });

  // `country`/`state` are no longer accepted at all (issue 2357, ruling
  // TAX-1a — the charge never read them); `nameAr` is the one clearable field.
  for (const field of ['nameAr'] as const) {
    it(`accepts null for ${field} and writes null`, async () => {
      const res = await request(app)
        .put(`/api/v1/stores/${STORE_ID}/tax/rates/rate-1`)
        .send({ [field]: null });

      expect(res.status).toBe(200);
      expect(mockPrisma.taxRate.update.mock.calls[0][0].data[field]).toBeNull();
    });
  }

  it('leaves the stored value alone when the key is omitted', async () => {
    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/tax/rates/rate-1`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(mockPrisma.taxRate.update.mock.calls[0][0].data.nameAr).toBeUndefined();
  });
});

// ─── Suppliers — apps/api/src/routes/suppliers.routes.ts ─────────────────────
//
// The half-fixed surface: the admin form was moved onto `textFieldValue(x,
// 'update')` (so an emptied field sends a clearing `null`) while the route kept
// `createSchema.partial()`, whose fields are `.optional()` but NOT
// `.nullable()`. Zod rejects null there, so the PATCH 422'd — and because most
// suppliers legitimately have no Arabic name or notes, that broke EVERY
// supplier edit, not just the clear. A caller-side gate
// (check-update-payload-clear.mjs) cannot see this; only the receiving schema
// can be asked whether it accepts what the form now sends.

describe('PATCH /stores/:storeId/suppliers/:id — an emptied supplier field clears', () => {
  let app: Express;

  beforeAll(async () => {
    const { default: supplierRouter } = await import('@api/routes/suppliers.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores', supplierRouter);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.supplier.findFirst.mockResolvedValue({ id: 'supplier-1' });
    mockPrisma.supplier.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'supplier-1', ...data })
    );
  });

  const NULLABLE_FIELDS = ['nameAr', 'contactName', 'phone', 'email', 'notes', 'notesAr'] as const;

  for (const field of NULLABLE_FIELDS) {
    it(`accepts null for ${field} and writes null`, async () => {
      const res = await request(app)
        .patch(`/api/v1/stores/${STORE_ID}/suppliers/supplier-1`)
        .send({ [field]: null });

      expect(res.status).toBe(200);
      expect(mockPrisma.supplier.update.mock.calls[0][0].data[field]).toBeNull();
    });
  }

  it("accepts the edit form's full clear-on-empty payload (the 422 that broke every edit)", async () => {
    // Verbatim shape of the page's payload for an existing supplier whose
    // optional fields are blank — the common case, and the one that 422'd.
    const res = await request(app).patch(`/api/v1/stores/${STORE_ID}/suppliers/supplier-1`).send({
      name: 'Al-Mutlaq Trading',
      nameAr: null,
      contactName: null,
      phone: null,
      email: null,
      paymentTerms: 'net30',
      leadTimeDays: 14,
      notes: null,
      notesAr: null,
    });

    expect(res.status).toBe(200);
    const written = mockPrisma.supplier.update.mock.calls[0][0].data;
    expect(written.leadTimeDays).toBe(14);
    for (const field of NULLABLE_FIELDS) expect(written[field]).toBeNull();
  });

  it('leaves the stored value alone when the key is omitted', async () => {
    const res = await request(app)
      .patch(`/api/v1/stores/${STORE_ID}/suppliers/supplier-1`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    const written = mockPrisma.supplier.update.mock.calls[0][0].data;
    for (const field of NULLABLE_FIELDS) expect(written[field]).toBeUndefined();
  });

  it('still rejects null for the required name, and still validates a real email', async () => {
    // Nullability was widened field-by-field, not by dropping validation.
    const nulledName = await request(app)
      .patch(`/api/v1/stores/${STORE_ID}/suppliers/supplier-1`)
      .send({ name: null });
    expect(nulledName.status).toBe(422);

    const badEmail = await request(app)
      .patch(`/api/v1/stores/${STORE_ID}/suppliers/supplier-1`)
      .send({ email: 'not-an-email' });
    expect(badEmail.status).toBe(422);

    const goodEmail = await request(app)
      .patch(`/api/v1/stores/${STORE_ID}/suppliers/supplier-1`)
      .send({ email: 'sales@almutlaq.com.kw' });
    expect(goodEmail.status).toBe(200);
    expect(mockPrisma.supplier.update.mock.calls[0][0].data.email).toBe('sales@almutlaq.com.kw');
  });
});

// ─── Warehouses admin caller — lat/lng must clear on update (issue #1568) ────
//
// updateWarehouseSchema (apps/api/src/routes/warehouse.routes.ts) already
// declares `lat`/`lng` as `.nullable().optional()` — the server has always
// accepted a clearing `null`. The bug was entirely in the admin caller:
// `apps/admin/src/app/stores/[id]/stock/warehouses/page.tsx` built the save
// payload as `form.lat !== '' ? parseFloat(form.lat) : undefined` (same for
// `lng`), so an emptied coordinate field always sent `undefined` — even on
// the update branch — and the old value silently survived the save, the
// numeric sibling of the text-field bug the rest of this file covers.
//
// A schema-level test can't catch this: the schema was never wrong. This is
// a static scan of the admin caller itself, so it fails on the OLD page.tsx
// (mutation-proven: temporarily restoring the old ternary line turns this
// red — see the fix commit for the captured output).
describe('warehouses admin caller — lat/lng use the clear-on-update helper', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../apps/admin/src/app/stores/[id]/stock/warehouses/page.tsx'),
    'utf-8'
  );

  it('does not build lat/lng with the raw "!== \'\' ? parse… : undefined" ternary', () => {
    // This is exactly the shape that dropped a cleared coordinate to
    // `undefined` on the update (PUT) branch instead of `null`.
    expect(source).not.toMatch(/!==\s*''\s*\?\s*parseFloat\([^)]*\)\s*:\s*undefined/);
  });

  it('routes lat through numericFieldValue so update sends null and create sends undefined', () => {
    expect(source).toMatch(/lat:\s*numericFieldValue\(/);
  });

  it('routes lng through numericFieldValue so update sends null and create sends undefined', () => {
    expect(source).toMatch(/lng:\s*numericFieldValue\(/);
  });
});
