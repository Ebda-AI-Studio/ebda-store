/**
 * Finance-side of the 2026-09-30 "selected filter does not apply" report,
 * over HTTP against real Postgres:
 *
 * - every finance XLSX export holds exactly the selected period, names it in
 *   its filename and carries a "Filters" sheet;
 * - the expenses list honours `status` and `hasOcr` (the finance dashboard's
 *   "Pending receipt drafts" card sent `hasOcr=true`, which the route never
 *   read, so the card counted every draft).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { prisma } from '@ebda/database';
import {
  seedCoaForStore,
  getSystemAccountIdByCode,
} from '../../apps/api/src/services/accounting/account.service';
import { postEntry } from '../../apps/api/src/services/accounting/journal.service';

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
vi.mock('../../apps/api/src/middleware/security', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const OWNER = '00000000-0000-0000-0000-0000000009b8';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let storeId: string;
let app: Express;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `rff-owner-${suffix}@x.test`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'F',
    },
  });
  const s = await prisma.store.create({
    data: { name: `rff-${suffix}`, slug: `rff-${suffix}`, ownerId: OWNER },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
  const cash = await getSystemAccountIdByCode(storeId, '1000');
  const revenue = await getSystemAccountIdByCode(storeId, '4000');
  const expenseAcct = await getSystemAccountIdByCode(storeId, '5990');
  const sale = (id: string, at: string, amount: number) =>
    postEntry({
      storeId,
      source: 'order',
      sourceId: `${id}-${suffix}`,
      postedAt: new Date(at),
      lines: [
        { accountId: cash, debit: amount, credit: 0 },
        { accountId: revenue, debit: 0, credit: amount },
      ],
    });
  await sale('aug', '2026-08-15T10:00:00Z', 1000);
  await sale('sep', '2026-09-15T10:00:00Z', 2000);

  let n = 0;
  const expense = (status: 'draft' | 'approved', receipt: string | null, date: string) =>
    prisma.expense.create({
      data: {
        storeId,
        expenseNumber: `EXP-${suffix}-${++n}`,
        expenseAccountId: expenseAcct,
        paidFromAccountId: cash,
        amount: 100 * n,
        total: 100 * n,
        status,
        receiptImageUrl: receipt,
        expenseDate: new Date(`${date}T00:00:00.000Z`),
      },
    });
  await expense('draft', 'https://r2.example/receipt.jpg', '2026-09-10'); // receipt draft
  await expense('draft', null, '2026-09-11'); // manual draft
  await expense('approved', null, '2026-09-12');
  await expense('draft', null, '2026-08-12'); // August

  const { default: financeRoutes } = await import('../../apps/api/src/routes/finance.routes');
  const { default: expensesRoutes } = await import('../../apps/api/src/routes/expenses.routes');
  app = express();
  app.use(express.json());
  app.use('/stores', financeRoutes);
  app.use('/stores', expensesRoutes);
});

afterAll(async () => {
  if (!storeId) return;
  await prisma.expense.deleteMany({ where: { storeId } });
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.store.delete({ where: { id: storeId } });
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
  return { wb, disposition: String(res.headers['content-disposition']) };
}

function amountOf(wb: ExcelJS.Workbook, sheet: string, label: string): number {
  let found = NaN;
  wb.getWorksheet(sheet)!.eachRow(row => {
    const vals = (row.values as unknown[]).map(v => (v === undefined ? '' : v));
    if (vals.includes(label)) found = Number(vals[vals.length - 1]);
  });
  return found;
}

const filtersText = (wb: ExcelJS.Workbook) =>
  JSON.stringify(wb.getWorksheet('Filters')!.getSheetValues());

describe('finance XLSX exports hold exactly the selected period', () => {
  it('P&L: August vs September differ, filename + Filters sheet name the range', async () => {
    const aug = await xlsx('/finance/reports/pnl.xlsx?from=2026-08-01&to=2026-08-31');
    const sep = await xlsx('/finance/reports/pnl.xlsx?from=2026-09-01&to=2026-09-30');
    expect(amountOf(aug.wb, 'P&L', 'Total Revenue')).toBe(10);
    expect(amountOf(sep.wb, 'P&L', 'Total Revenue')).toBe(20);
    expect(sep.disposition).toContain('pnl-2026-09-01_to_2026-09-30.xlsx');
    expect(filtersText(sep.wb)).toContain('2026-09-01 to 2026-09-30');
  });

  it('trial balance: as-of before September excludes the September sale', async () => {
    const aug = await xlsx('/finance/reports/trial-balance.xlsx?asOf=2026-08-31');
    const sep = await xlsx('/finance/reports/trial-balance.xlsx?asOf=2026-09-30');
    const cashDebit = (wb: ExcelJS.Workbook) => {
      let v = NaN;
      wb.getWorksheet('Trial Balance')!.eachRow(row => {
        if (row.getCell(1).value === '1000') v = Number(row.getCell(4).value);
      });
      return v;
    };
    expect(cashDebit(aug.wb)).toBe(10); // 1000 piastres = 10.00 EGP
    expect(cashDebit(sep.wb)).toBe(30);
    expect(aug.disposition).toContain('trial-balance-as-of-2026-08-31.xlsx');
    expect(filtersText(aug.wb)).toContain('2026-08-31');
  });

  it('balance sheet: as-of changes the totals and is named in the file', async () => {
    const aug = await xlsx('/finance/reports/balance-sheet.xlsx?asOf=2026-08-31');
    const sep = await xlsx('/finance/reports/balance-sheet.xlsx?asOf=2026-09-30');
    expect(amountOf(aug.wb, 'Balance Sheet', 'Total Assets')).toBe(10);
    expect(amountOf(sep.wb, 'Balance Sheet', 'Total Assets')).toBe(30);
    expect(sep.disposition).toContain('balance-sheet-as-of-2026-09-30.xlsx');
  });

  it('tax report: filename + Filters sheet carry the range', async () => {
    const r = await xlsx('/finance/reports/tax-report.xlsx?from=2026-09-01&to=2026-09-30');
    expect(r.disposition).toContain('tax-report-2026-09-01_to_2026-09-30.xlsx');
    expect(filtersText(r.wb)).toContain('2026-09-01 to 2026-09-30');
  });
});

describe('expenses list honours every filter it is sent', () => {
  const totals = async (qs: string) => {
    const res = await get(`/expenses?${qs}`);
    expect(res.status).toBe(200);
    return (res.body.data as Array<{ amount: number }>).map(e => e.amount).sort();
  };

  it('status + hasOcr: only the receipt draft (the dashboard card count)', async () => {
    const res = await get('/expenses?status=draft&hasOcr=true&perPage=1&page=1');
    expect(res.body.meta.total).toBe(1);
    expect(await totals('status=draft&hasOcr=true')).toEqual([100]);
  });

  it('status alone: every draft', async () => {
    expect(await totals('status=draft')).toEqual([100, 200, 400]);
  });

  it('date range: calendar days, September only', async () => {
    expect(await totals('from=2026-09-01&to=2026-09-30')).toEqual([100, 200, 300]);
    expect(await totals('from=2026-08-01&to=2026-08-31')).toEqual([400]);
  });
});
