/**
 * Finance Reports count days in the STORE's time zone (owner decision
 * 2026-10-01, Ruling FRT-1), over HTTP against real Postgres.
 *
 * Two tax-bearing order sales around the September → October boundary of a
 * Egypt (UTC+3) store:
 *
 *   LATE  — 2026-09-30 23:30 UTC = 2026-10-01 02:30 Egypt → OCTOBER
 *           (whole-UTC-day periods put it in September)
 *   EARLY — 2026-09-30 01:30 Egypt = 2026-09-29 22:30 UTC → September, but on
 *           the 30th (whole-UTC-day periods put it on the 29th)
 *
 * The assertions name which month's P&L and tax report each lands in, which
 * day the trial balance / balance sheet as-of cut puts it on, and that the
 * store's configured zone — not the server's TZ — decides. The file is green
 * under both `TZ=UTC` and `TZ=Africa/Cairo`.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { prisma, runInTenantContext } from '@ebda/database';
import { seedCoaForStore } from '../../apps/api/src/services/accounting/account.service';
import { postOrderPaymentJournal } from '../../apps/api/src/services/accounting/posting/order-posting';

import { fromMinor } from '@ebda/shared';
vi.mock('../../apps/api/src/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._r: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('../../apps/api/src/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const OWNER = '00000000-0000-0000-0000-00000000f71a';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let storeId: string;
let app: Express;

// Piastres. Distinct amounts so every total says which sale it holds.
const LATE = { subtotal: 10_000, tax: 500, at: '2026-09-30T23:30:00.000Z' };
const EARLY = { subtotal: 20_000, tax: 1_000, at: '2026-09-29T22:30:00.000Z' };

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `frt-owner-${suffix}@x.test`,
      passwordHash: 'x',
      firstName: 'F',
      lastName: 'T',
    },
  });
  // No timezone given: the column default (Africa/Cairo) applies, like every
  // prod store today.
  const s = await prisma.store.create({
    data: { name: `frt-${suffix}`, slug: `frt-${suffix}`, ownerId: OWNER, accountingEnabled: true },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
  const product = await prisma.product.create({
    data: {
      storeId,
      name: 'FRT product',
      slug: `frt-product-${suffix}`,
      price: 10_000,
      inventory: 100,
      status: 'active',
    },
  });

  const sale = async (key: string, o: typeof LATE) => {
    const total = o.subtotal + o.tax;
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `FRT-${key}-${suffix}`,
        status: 'confirmed',
        paymentStatus: 'paid',
        subtotal: o.subtotal,
        tax: o.tax,
        shipping: 0,
        discount: 0,
        total,
        currency: 'EGP',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId: product.id,
              productName: 'FRT product',
              quantity: 1,
              price: o.subtotal,
              total: o.subtotal,
            },
          ],
        },
        payments: {
          create: [
            { provider: 'paymob', status: 'completed', amount: total, paidAt: new Date(o.at) },
          ],
        },
      },
    });
    // Production posts inside runInTenantContext(storeId).
    await runInTenantContext(storeId, () => postOrderPaymentJournal({ orderId: order.id }));
    const moved = await prisma.journalEntry.updateMany({
      where: { storeId, source: 'order', sourceId: order.id },
      data: { postedAt: new Date(o.at) },
    });
    expect(moved.count).toBe(1);
  };
  await sale('late', LATE);
  await sale('early', EARLY);

  const { default: financeRoutes } = await import('../../apps/api/src/routes/finance.routes');
  app = express();
  app.use(express.json());
  app.use('/stores', financeRoutes);
});

afterAll(async () => {
  if (!storeId) return;
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.payment.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

const get = (path: string) => request(app).get(`/stores/${storeId}${path}`);

async function json<T = any>(path: string): Promise<T> {
  const res = await get(path);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as T;
}

const SEP = 'from=2026-09-01&to=2026-09-30';
const OCT = 'from=2026-10-01&to=2026-10-31';

const pnlRevenue = async (qs: string) =>
  (await json<{ revenue: { total: number } }>(`/finance/reports/pnl?${qs}`)).revenue.total;

const tax = (qs: string) =>
  json<{
    rows: Array<{ date: string; orderNumber: string; taxCollected: number }>;
    summary: { totalTaxCollected: number; totalTaxableSales: number };
  }>(`/finance/reports/tax-report?${qs}`);

const cashDebitAsOf = async (asOf: string) => {
  const rows = await json<Array<{ code: string; debitTotal: number }>>(
    `/finance/reports/trial-balance?asOf=${asOf}`
  );
  return rows.find(r => r.code === '1000')?.debitTotal ?? 0;
};

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
  return { wb, disposition: String(res.headers['content-disposition']) };
}

function lastNumberOnRow(wb: ExcelJS.Workbook, sheet: string, label: string): number {
  let found = NaN;
  wb.getWorksheet(sheet)!.eachRow(row => {
    const vals = (row.values as unknown[]).map(v => (v === undefined ? '' : v));
    if (vals.includes(label)) found = Number(vals[vals.length - 1]);
  });
  return found;
}

describe('Egypt store (column default): days are Egypt days', () => {
  it('P&L: the 23:30 UTC sale is OCTOBER revenue; the 01:30 Egypt sale is September', async () => {
    expect(await pnlRevenue(SEP)).toBe(EARLY.subtotal);
    expect(await pnlRevenue(OCT)).toBe(LATE.subtotal);
  });

  it("tax report: each sale's tax is in its Egypt month, dated its Egypt day", async () => {
    const sep = await tax(SEP);
    const oct = await tax(OCT);
    expect(sep.summary.totalTaxCollected).toBe(EARLY.tax);
    expect(sep.summary.totalTaxableSales).toBe(EARLY.subtotal);
    expect(sep.rows.map(r => r.date)).toEqual(['2026-09-30']);
    expect(oct.summary.totalTaxCollected).toBe(LATE.tax);
    expect(oct.rows.map(r => r.date)).toEqual(['2026-10-01']);
  });

  it('trial balance as-of: the 01:30 Egypt sale is on the 30th, the 23:30 UTC one on Oct 1', async () => {
    const total = (o: typeof LATE) => o.subtotal + o.tax;
    expect(await cashDebitAsOf('2026-09-29')).toBe(0);
    expect(await cashDebitAsOf('2026-09-30')).toBe(total(EARLY));
    expect(await cashDebitAsOf('2026-10-01')).toBe(total(EARLY) + total(LATE));
  });

  it('balance sheet as of Sep 30 holds only the September sale', async () => {
    const bs = await json<{ assets: { total: number } }>(
      '/finance/reports/balance-sheet?asOf=2026-09-30'
    );
    expect(bs.assets.total).toBe(EARLY.subtotal + EARLY.tax);
  });

  it('exports agree: P&L and tax XLSX for October hold the late sale, named in Egypt days', async () => {
    const pnl = await xlsx(`/finance/reports/pnl.xlsx?${OCT}`);
    expect(lastNumberOnRow(pnl.wb, 'P&L', 'Total Revenue')).toBe(fromMinor(LATE.subtotal));
    expect(pnl.disposition).toContain('pnl-2026-10-01_to_2026-10-31.xlsx');

    const t = await xlsx(`/finance/reports/tax-report.xlsx?${OCT}`);
    expect(t.disposition).toContain('tax-report-2026-10-01_to_2026-10-31.xlsx');
    let saleDate = '';
    t.wb.getWorksheet('Tax Report')!.eachRow(row => {
      if (row.getCell(1).value === 'Sale') saleDate = String(row.getCell(2).value);
    });
    expect(saleDate).toBe('2026-10-01');

    const tb = await xlsx('/finance/reports/trial-balance.xlsx?asOf=2026-09-30');
    expect(tb.disposition).toContain('trial-balance-as-of-2026-09-30.xlsx');
  });
});

describe("the store's configured zone decides, not a fixed offset", () => {
  it('a UTC store counts both sales in September (whole UTC days)', async () => {
    await prisma.store.update({ where: { id: storeId }, data: { timezone: 'UTC' } });
    try {
      expect(await pnlRevenue(SEP)).toBe(EARLY.subtotal + LATE.subtotal);
      expect(await pnlRevenue(OCT)).toBe(0);
      expect((await tax(SEP)).summary.totalTaxCollected).toBe(EARLY.tax + LATE.tax);
    } finally {
      await prisma.store.update({ where: { id: storeId }, data: { timezone: 'Africa/Cairo' } });
    }
  });

  it('a store with no usable zone falls back to Africa/Cairo (Ruling FRT-2)', async () => {
    for (const bad of ['', 'Not/AZone']) {
      await prisma.store.update({ where: { id: storeId }, data: { timezone: bad } });
      try {
        expect(await pnlRevenue(OCT)).toBe(LATE.subtotal);
        expect((await tax(SEP)).summary.totalTaxCollected).toBe(EARLY.tax);
      } finally {
        await prisma.store.update({ where: { id: storeId }, data: { timezone: 'Africa/Cairo' } });
      }
    }
  });
});
