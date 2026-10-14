/**
 * Owner report 2026-09-30: "for the sales reports, why does the selected
 * filter not apply?" — and the orders export he downloaded held the whole
 * store history (every status, every date) while his list was filtered.
 *
 * Every surface below is driven over HTTP against real Postgres with the SAME
 * query string the admin builds (via the `@ebda/shared` contract helpers),
 * and each test asserts that a DIFFERENT selected filter changes both the
 * request AND the rows that come back. Auth is stubbed; the routers,
 * services and SQL are the real ones.
 *
 * Egypt is UTC+3, so the fixtures use Egypt-local day boundaries:
 * "September" = 2026-08-31T21:00Z … 2026-09-30T20:59:59.999Z. An order at
 * 2026-09-30T22:30Z is 1 Oct 01:30 in Egypt — OUTSIDE September for the
 * merchant, although it is Sep 30 in UTC.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { prisma } from '@ebda/database';
import {
  reportRangeQueryString,
  orderListFilterParams,
  customerListFilterParams,
  reportRangeParams,
  localDayRange,
} from '@ebda/shared';

vi.mock('../../apps/api/src/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._r: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
  customerUserId: () => undefined,
}));
vi.mock('../../apps/api/src/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: async () => ({ ok: true }),
}));
vi.mock('../../apps/api/src/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/middleware/security', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const OWNER = '00000000-0000-0000-0000-0000000009b7';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let storeId: string;
let app: Express;
const customerIds: string[] = [];

/** Egypt-local calendar months as the admin resolves them. */
const AUG = {
  startDate: new Date('2026-07-31T21:00:00.000Z'),
  endDate: new Date('2026-08-31T20:59:59.999Z'),
};
const SEP = {
  startDate: new Date('2026-08-31T21:00:00.000Z'),
  endDate: new Date('2026-09-30T20:59:59.999Z'),
};

let seq = 0;
async function order(opts: {
  at: string;
  total: number;
  status?: 'pending' | 'confirmed' | 'delivered' | 'cancelled';
  customerId?: string;
  productId?: string;
  abandonedAt?: string;
}) {
  return prisma.order.create({
    data: {
      storeId,
      orderNumber: `RF-${suffix}-${++seq}`,
      status: opts.status ?? 'delivered',
      // An abandoned checkout never paid (and so is not revenue).
      paymentStatus: opts.abandonedAt ? 'failed' : 'paid',
      subtotal: opts.total,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: opts.total,
      currency: 'EGP',
      customerId: opts.customerId,
      shippingAddress: {},
      billingAddress: {},
      createdAt: new Date(opts.at),
      paymentGatewayAbandonedAt: opts.abandonedAt ? new Date(opts.abandonedAt) : undefined,
      items: opts.productId
        ? {
            create: [
              {
                productId: opts.productId,
                productName: 'P',
                quantity: 1,
                price: opts.total,
                total: opts.total,
              },
            ],
          }
        : undefined,
    },
  });
}

let augOrder: string;
let sepOrder: string;
let sepCancelled: string;
let kuwaitOct1: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `rf-owner-${suffix}@x.test`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'F',
    },
  });
  const s = await prisma.store.create({
    data: { name: `rf-${suffix}`, slug: `rf-${suffix}`, ownerId: OWNER },
  });
  storeId = s.id;

  for (const [first, last] of [
    ['Aisha', 'Augustus'],
    ['Salem', 'September'],
  ]) {
    const u = await prisma.user.create({
      data: {
        email: `rf-${first.toLowerCase()}-${suffix}@x.test`,
        passwordHash: 'x',
        firstName: first,
        lastName: last,
        role: 'customer',
      },
    });
    customerIds.push(u.id);
  }
  const [aisha, salem] = customerIds;

  const product = await prisma.product.create({
    data: { storeId, name: 'P', slug: `p-${suffix}`, price: 1000, inventory: 5 },
  });

  augOrder = (
    await order({
      at: '2026-08-15T10:00:00Z',
      total: 1000,
      customerId: aisha,
      productId: product.id,
    })
  ).id;
  sepOrder = (
    await order({
      at: '2026-09-15T10:00:00Z',
      total: 2000,
      customerId: salem,
      productId: product.id,
    })
  ).id;
  sepCancelled = (
    await order({ at: '2026-09-16T10:00:00Z', total: 500, status: 'cancelled', customerId: salem })
  ).id;
  // Sep 30 in UTC, 1 Oct in Egypt.
  kuwaitOct1 = (await order({ at: '2026-09-30T22:30:00Z', total: 700, customerId: salem })).id;
  // Payment abandonments, one per month.
  await order({
    at: '2026-08-20T10:00:00Z',
    total: 300,
    status: 'pending',
    abandonedAt: '2026-08-20T10:05:00Z',
  });
  await order({
    at: '2026-09-20T10:00:00Z',
    total: 400,
    status: 'pending',
    abandonedAt: '2026-09-20T10:05:00Z',
  });

  const { default: analyticsRoutes } = await import('../../apps/api/src/routes/analytics.routes');
  const { default: orderRoutes } = await import('../../apps/api/src/routes/order.routes');
  const { default: customersRoutes } = await import('../../apps/api/src/routes/customers.routes');
  const { default: abandonRoutes } =
    await import('../../apps/api/src/routes/payment-abandonments.routes');
  const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores/:storeId/analytics', analyticsRoutes);
  app.use('/stores/:storeId/orders', orderRoutes);
  app.use('/stores/:storeId', customersRoutes);
  app.use('/stores/:storeId/payment-abandonments', abandonRoutes);
  app.use(errorHandler);
});

afterAll(async () => {
  if (!storeId) return;
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: { in: customerIds } } });
});

const get = (path: string) => request(app).get(`/stores/${storeId}${path}`);

async function xlsx(path: string) {
  const res = await get(path)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as Buffer);
  return { wb, res };
}

function column(wb: ExcelJS.Workbook, sheet: string, header: string): string[] {
  const ws = wb.getWorksheet(sheet)!;
  const headers = (ws.getRow(1).values as unknown[]).map(v => String(v ?? ''));
  const col = headers.indexOf(header);
  const out: string[] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const v = row.getCell(col).value;
    if (v !== null && v !== undefined && v !== '') out.push(String(v));
  });
  return out;
}

describe('analytics: the selected range reaches every period-based widget', () => {
  it('dashboard revenue follows the range', async () => {
    const aug = await get(`/analytics/dashboard?${reportRangeQueryString(AUG)}`);
    const sep = await get(`/analytics/dashboard?${reportRangeQueryString(SEP)}`);
    expect(aug.status).toBe(200);
    expect(aug.body.data.stats.totalRevenue).toBe(1000);
    // Sep: 2000 delivered; the cancelled order and the Egypt-Oct-1 order excluded.
    expect(sep.body.data.stats.totalRevenue).toBe(2000);
  });

  it('sales chart follows the range', async () => {
    const q = (r: typeof AUG) =>
      get(`/analytics/sales?period=custom&${reportRangeQueryString(r)}&tzOffset=180`);
    const sum = (res: any) => res.body.data.sales.reduce((s: number, b: any) => s + b.revenue, 0);
    expect(sum(await q(AUG))).toBe(1000);
    expect(sum(await q(SEP))).toBe(2000);
  });

  it('top products follow the range', async () => {
    const aug = await get(`/analytics/top-products?limit=5&${reportRangeQueryString(AUG)}`);
    const sep = await get(`/analytics/top-products?limit=5&${reportRangeQueryString(SEP)}`);
    expect(aug.body.data.products[0].revenue).toBe(1000);
    expect(sep.body.data.products[0].revenue).toBe(2000);
  });

  it('half a range or a garbage date is a 422, never a silent month-to-date', async () => {
    const half = await get(
      `/analytics/dashboard?startDate=${encodeURIComponent(SEP.startDate.toISOString())}`
    );
    expect(half.status).toBe(422);
    const bad = await get(`/analytics/top-products?startDate=nope&endDate=nope`);
    expect(bad.status).toBe(422);
  });
});

describe('orders list: every filter is applied server-side', () => {
  const list = async (f: Parameters<typeof orderListFilterParams>[0]) => {
    const qs = orderListFilterParams(f);
    qs.set('limit', '100');
    const res = await get(`/orders?${qs}`);
    expect(res.status).toBe(200);
    return (res.body.data.orders as Array<{ id: string }>).map(o => o.id).sort();
  };

  it('date range: Egypt-local days (the UTC-Sep-30 order is Oct 1 for the merchant)', async () => {
    expect(await list({ range: AUG })).toContain(augOrder);
    const sep = await list({ range: SEP });
    expect(sep).toEqual(expect.arrayContaining([sepOrder, sepCancelled]));
    expect(sep).not.toContain(augOrder);
    expect(sep).not.toContain(kuwaitOct1);
  });

  it('status narrows the rows', async () => {
    expect(await list({ range: SEP, status: 'cancelled' })).toEqual([sepCancelled]);
  });

  it('search matches across ALL pages, not only the fetched one', async () => {
    const qs = orderListFilterParams({ search: 'augustus' });
    qs.set('limit', '1');
    const res = await get(`/orders?${qs}`);
    expect(res.body.data.orders.map((o: any) => o.id)).toEqual([augOrder]);
    expect(res.body.data.meta.total).toBe(1);
  });

  it('payment status narrows the rows (Orders PWA "paid" filter, server-side)', async () => {
    const paid = await list({ range: SEP, paymentStatus: 'paid' });
    expect(paid).toEqual(expect.arrayContaining([sepOrder, sepCancelled]));
    const failed = await list({ range: SEP, paymentStatus: 'failed' });
    expect(failed).not.toContain(sepOrder);
  });

  it('an unknown status is a 422, not a 500', async () => {
    expect((await get('/orders?status=nope')).status).toBe(422);
  });
});

describe('orders export = exactly the filtered list', () => {
  it('holds only the filtered rows, names the range, and carries a Filters sheet', async () => {
    const qs = orderListFilterParams({ range: SEP, status: 'delivered' });
    qs.set('tzOffset', '180');
    const { wb, res } = await xlsx(`/orders/export.xlsx?${qs}`);

    const exported = column(wb, 'Orders', 'Order #');
    const expected = await prisma.order.findMany({
      where: { id: { in: [sepOrder] } },
      select: { orderNumber: true },
    });
    expect(exported).toEqual(expected.map(o => o.orderNumber));

    expect(res.headers['content-disposition']).toContain('orders-2026-09-01_to_2026-09-30.xlsx');
    const filters = wb.getWorksheet('Filters')!;
    const text = JSON.stringify(filters.getSheetValues());
    expect(text).toContain('2026-09-01 to 2026-09-30');
    expect(text).toContain('delivered');
  });

  it('a different range exports different rows', async () => {
    const { wb } = await xlsx(`/orders/export.xlsx?${orderListFilterParams({ range: AUG })}`);
    const aug = await prisma.order.findUniqueOrThrow({ where: { id: augOrder } });
    expect(column(wb, 'Orders', 'Order #')).toContain(aug.orderNumber);
    const sep = await prisma.order.findUniqueOrThrow({ where: { id: sepOrder } });
    expect(column(wb, 'Orders', 'Order #')).not.toContain(sep.orderNumber);
  });
});

describe('customers export = exactly the filtered list', () => {
  it('search narrows the Customers AND Purchases sheets', async () => {
    const { wb, res } = await xlsx(
      `/customers/export.xlsx?${customerListFilterParams({ search: 'augustus' })}`
    );
    const emails = column(wb, 'Customers', 'Email');
    expect(emails).toEqual([`rf-aisha-${suffix}@x.test`]);
    const purchaseEmails = new Set(column(wb, 'Purchases', 'Email'));
    expect([...purchaseEmails]).toEqual([`rf-aisha-${suffix}@x.test`]);
    expect(JSON.stringify(wb.getWorksheet('Filters')!.getSheetValues())).toContain('augustus');
    expect(res.headers['content-disposition']).toContain('-search-');
  });

  it('no filter exports every customer', async () => {
    const { wb } = await xlsx('/customers/export.xlsx');
    expect(column(wb, 'Customers', 'Email')).toEqual(
      expect.arrayContaining([`rf-aisha-${suffix}@x.test`, `rf-salem-${suffix}@x.test`])
    );
  });
});

describe('payment abandonments: the list follows the picked days', () => {
  it('Aug vs Sep give different rows', async () => {
    const q = (from: string, to: string) =>
      get(`/payment-abandonments?${new URLSearchParams(reportRangeParams(localRange(from, to)))}`);
    const aug = await q('2026-08-01', '2026-08-31');
    const sep = await q('2026-09-01', '2026-09-30');
    expect(aug.body.data.abandoners.map((a: any) => a.total)).toEqual([300]);
    expect(sep.body.data.abandoners.map((a: any) => a.total)).toEqual([400]);
  });
});

/** `localDayRange` pinned to Egypt so the test does not depend on the runner's TZ. */
function localRange(from: string, to: string) {
  const r = localDayRange(from, to)!;
  const shift = (d: Date) => new Date(d.getTime() + d.getTimezoneOffset() * 60_000 - 180 * 60_000);
  return { startDate: shift(r.startDate), endDate: shift(r.endDate) };
}
