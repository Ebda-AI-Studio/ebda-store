/**
 * Period-correctness of the GL reports (reports.service.ts) and the analytics
 * cashflow trend, against a real Postgres.
 *
 * The defect this pins (audit 2026-09-30, finding 1): `trialBalance()` put its
 * status/date predicate in the ON clause of a LEFT JOIN on journal_entries
 * while summing lines from an unconditional LEFT JOIN on journal_lines, so the
 * predicate filtered nothing. Every trial balance was all-time, and every P&L
 * (closing − opening) was 0 — which also zeroed the finance dashboard's
 * this-month figures and the revenue/margin anomaly alerts.
 *
 * Every fixture here is created per test run (unique store), so a --retry
 * re-run gets fresh rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import {
  seedCoaForStore,
  getSystemAccountIdByCode,
} from '../../../apps/api/src/services/accounting/account.service';
import { postEntry, reverseEntry } from '../../../apps/api/src/services/accounting/journal.service';
import {
  trialBalance,
  profitAndLoss,
  balanceSheet,
} from '../../../apps/api/src/services/accounting/reports.service';
import { AnalyticsService } from '../../../apps/api/src/services/analytics.service';

const OWNER = '00000000-0000-0000-0000-0000000000f7';
let storeId: string;
const acct: Record<string, string> = {};

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `fin-reports-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Fin',
      lastName: 'Reports',
    },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = await prisma.store.create({
    data: { name: `fin-reports-${suffix}`, slug: `fin-reports-${suffix}`, ownerId: OWNER },
  });
  storeId = store.id;
  await seedCoaForStore(storeId);
  for (const code of ['1000', '1200', '3000', '4000', '5000']) {
    acct[code] = await getSystemAccountIdByCode(storeId, code);
  }

  const sale = (sourceId: string, postedAt: Date, amount: number) =>
    postEntry({
      storeId,
      source: 'order',
      sourceId,
      postedAt,
      lines: [
        { accountId: acct['1000'], debit: amount, credit: 0 },
        { accountId: acct['4000'], debit: 0, credit: amount },
      ],
    });

  // Opening inventory carried in as equity (Jan 1).
  await postEntry({
    storeId,
    source: 'opening_balance',
    sourceId: `opening-${suffix}`,
    postedAt: at('2026-01-01T08:00:00.000Z'),
    lines: [
      { accountId: acct['1200'], debit: 5000, credit: 0 },
      { accountId: acct['3000'], debit: 0, credit: 5000 },
    ],
  });
  await sale(`jan-${suffix}`, at('2026-01-15T10:00:00.000Z'), 10000);
  await sale(`feb-${suffix}`, at('2026-02-10T10:00:00.000Z'), 5000);
  // COGS in February.
  await postEntry({
    storeId,
    source: 'order',
    sourceId: `feb-${suffix}:cogs`,
    postedAt: at('2026-02-12T10:00:00.000Z'),
    lines: [
      { accountId: acct['5000'], debit: 2000, credit: 0 },
      { accountId: acct['1200'], debit: 0, credit: 2000 },
    ],
  });
  // A February sale refunded in March: the ORIGINAL ends up status
  // 'reversed', the mirror is 'posted'.
  const refunded = await sale(`feb-refunded-${suffix}`, at('2026-02-20T10:00:00.000Z'), 3000);
  const reversal = await reverseEntry(refunded.id, 'refund applied');
  await prisma.journalEntry.update({
    where: { id: reversal.id },
    data: { postedAt: at('2026-03-10T10:00:00.000Z') },
  });
  await sale(`mar-${suffix}`, at('2026-03-05T10:00:00.000Z'), 7000);
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  // The reversal FK points original → mirror; clear it before deleting.
  await prisma.journalEntry.updateMany({ where: { storeId }, data: { reversedById: null } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

const row = (rows: Awaited<ReturnType<typeof trialBalance>>, code: string) =>
  rows.find(r => r.code === code)!;

describe('profitAndLoss counts only the requested period', () => {
  it('January: only the January sale', async () => {
    const pnl = await profitAndLoss(
      storeId,
      at('2026-01-01T00:00:00.000Z'),
      at('2026-01-31T23:59:59.999Z')
    );
    expect(pnl.totalRevenue).toBe(10000);
    expect(pnl.totalExpenses).toBe(0);
    expect(pnl.netIncome).toBe(10000);
  });

  it('February: both February sales (the later-refunded one included) and February COGS', async () => {
    const pnl = await profitAndLoss(
      storeId,
      at('2026-02-01T00:00:00.000Z'),
      at('2026-02-28T23:59:59.999Z')
    );
    // 5000 + 3000: the refunded sale's ORIGINAL (status 'reversed') still
    // belongs to February; its reversal lands in March.
    expect(pnl.totalRevenue).toBe(8000);
    expect(pnl.totalExpenses).toBe(2000);
    expect(pnl.netIncome).toBe(6000);
  });

  it('March: the March sale minus the March refund reversal', async () => {
    const pnl = await profitAndLoss(
      storeId,
      at('2026-03-01T00:00:00.000Z'),
      at('2026-03-31T23:59:59.999Z')
    );
    expect(pnl.totalRevenue).toBe(4000);
    expect(pnl.netIncome).toBe(4000);
  });

  it('a period with no entries is 0, not the all-time total', async () => {
    const pnl = await profitAndLoss(
      storeId,
      at('2025-06-01T00:00:00.000Z'),
      at('2025-06-30T23:59:59.999Z')
    );
    expect(pnl.totalRevenue).toBe(0);
    expect(pnl.totalExpenses).toBe(0);
  });

  it('the period boundaries are inclusive on both ends', async () => {
    const pnl = await profitAndLoss(
      storeId,
      at('2026-01-15T10:00:00.000Z'),
      at('2026-01-15T10:00:00.000Z')
    );
    expect(pnl.totalRevenue).toBe(10000);
  });
});

describe('trialBalance / opening balance exclude later entries', () => {
  it('as of Jan 31 contains only entries posted by then', async () => {
    const tb = await trialBalance(storeId, at('2026-01-31T23:59:59.999Z'));
    expect(row(tb, '4000').creditTotal).toBe(10000);
    expect(row(tb, '1000').debitTotal).toBe(10000);
    expect(row(tb, '5000').debitTotal).toBe(0);
  });

  it('before the first entry every account is zero', async () => {
    const tb = await trialBalance(storeId, at('2025-12-31T23:59:59.999Z'));
    expect(tb.length).toBeGreaterThan(0);
    for (const r of tb) {
      expect(r.debitTotal).toBe(0);
      expect(r.creditTotal).toBe(0);
    }
  });

  it('all-time totals net a refund to zero (original + reversal both counted)', async () => {
    const tb = await trialBalance(storeId);
    // 10000 + 5000 + 3000 + 7000 credited, 3000 debited by the reversal.
    expect(row(tb, '4000').creditTotal).toBe(25000);
    expect(row(tb, '4000').debitTotal).toBe(3000);
    expect(row(tb, '4000').balance).toBe(-22000);
  });
});

describe('balanceSheet balances and honours asOf', () => {
  it('as of Feb 28: Assets = Liabilities + Equity, earnings to date included', async () => {
    const bs = await balanceSheet(storeId, at('2026-02-28T23:59:59.999Z'));
    // Cash 18000 + Inventory (5000 − 2000) = 21000.
    expect(bs.totalAssets).toBe(21000);
    // Earnings to Feb 28: 10000 + 8000 − 2000.
    expect(bs.currentEarnings).toBe(16000);
    const earningsRow = bs.equity.find(r => r.kind === 'current_earnings');
    expect(earningsRow).toBeDefined();
    expect(-earningsRow!.balance).toBe(16000);
    expect(bs.totalEquity).toBe(21000);
    expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity);
    expect(bs.difference).toBe(0);
  });

  it('a later asOf reflects later entries and still balances', async () => {
    const bs = await balanceSheet(storeId, at('2026-12-31T23:59:59.999Z'));
    // Cash 25000 − 3000 refund + inventory 3000.
    expect(bs.totalAssets).toBe(25000);
    expect(bs.currentEarnings).toBe(20000);
    expect(bs.difference).toBe(0);
  });

  it('an asOf before any entry is an empty, balanced sheet', async () => {
    const bs = await balanceSheet(storeId, at('2025-12-31T23:59:59.999Z'));
    expect(bs.totalAssets).toBe(0);
    expect(bs.currentEarnings).toBe(0);
    expect(bs.difference).toBe(0);
  });
});

describe('cashflowTrend counts a refund once', () => {
  it('keeps the reversed ORIGINAL sale so its reversal nets it, not doubles it', async () => {
    const trend = await AnalyticsService.cashflowTrend(
      storeId,
      at('2026-02-01T00:00:00.000Z'),
      at('2026-03-31T23:59:59.999Z')
    );
    const byDay = new Map(trend.map(p => [new Date(p.day).toISOString().slice(0, 10), p.net]));
    expect(byDay.get('2026-02-20')).toBe(3000);
    expect(byDay.get('2026-03-10')).toBe(-3000);
    const total = trend.reduce((s, p) => s + p.net, 0);
    // 5000 + 3000 + 7000 − 3000. Counting only 'posted' gave 9000.
    expect(total).toBe(12000);
  });
});
