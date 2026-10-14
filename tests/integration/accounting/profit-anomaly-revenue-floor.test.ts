/**
 * revenue_drop thin-data floor + prior-window baseline (issues 2245 / 2268).
 *
 * revenue_drop went live for the first time when the 2026-09-30 P&L fix made
 * profitAndLoss return real numbers. It was the only metric with no absolute
 * floor, and its baseline (28d / 4) contained the very week it was compared
 * against. Pinned here against a real Postgres:
 *  - a thin store's quiet week does NOT page;
 *  - a real drop off a real baseline still fires p0;
 *  - the baseline is the 3 weeks BEFORE the current one (a 58% week vs a
 *    1,000 EGP/week prior reads −42% → p0; the old contaminated baseline read
 *    it as −35% → warning).
 *
 * Every store is created per test, so a --retry re-run gets fresh rows.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { prisma } from '@ebda/database';

vi.mock('../../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(async () => ({
    explanationEn: 'X',
    explanationAr: 'Y',
    likelyCause: 'demand',
  })),
  callGeminiBatch: vi.fn(async () => []),
}));
vi.mock('../../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));

import {
  seedCoaForStore,
  getSystemAccountIdByCode,
} from '../../../apps/api/src/services/accounting/account.service';
import { postEntry } from '../../../apps/api/src/services/accounting/journal.service';
import { runProfitAnomalyScan } from '../../../apps/api/src/services/accounting/profit-anomaly.service';

const OWNER = '00000000-0000-0000-0000-0000000000f9';
const stores: string[] = [];
const DAY = 24 * 60 * 60 * 1000;

async function storeWithSales(sales: Array<{ daysAgo: number; piastres: number }>) {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `rev-floor-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Rev',
      lastName: 'Floor',
    },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = await prisma.store.create({
    data: {
      name: `rev-floor-${suffix}`,
      slug: `rev-floor-${suffix}`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
    },
  });
  stores.push(store.id);
  await seedCoaForStore(store.id);
  const cash = await getSystemAccountIdByCode(store.id, '1000');
  const revenue = await getSystemAccountIdByCode(store.id, '4000');
  let i = 0;
  for (const sale of sales) {
    await postEntry({
      storeId: store.id,
      source: 'order',
      sourceId: `sale-${suffix}-${i++}`,
      postedAt: new Date(Date.now() - sale.daysAgo * DAY),
      lines: [
        { accountId: cash, debit: sale.piastres, credit: 0 },
        { accountId: revenue, debit: 0, credit: sale.piastres },
      ],
    });
  }
  return store.id;
}

const revenueDrop = (storeId: string) =>
  prisma.profitAnomaly.findFirst({ where: { storeId, metric: 'revenue_drop' } });

afterAll(async () => {
  for (const storeId of stores) {
    await prisma.profitAnomaly.deleteMany({ where: { storeId } });
    await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
    await prisma.journalEntry.deleteMany({ where: { storeId } });
    await prisma.sequence.deleteMany({ where: { storeId } });
    await prisma.account.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describe('revenue_drop', () => {
  it('a thin store (30 EGP/week) with a quiet week does not page', async () => {
    const storeId = await storeWithSales([
      { daysAgo: 10, piastres: 3000 },
      { daysAgo: 17, piastres: 3000 },
      { daysAgo: 24, piastres: 3000 },
    ]);
    await runProfitAnomalyScan(storeId);
    expect(await revenueDrop(storeId)).toBeNull();
  });

  it('a real drop off a real baseline still pages p0', async () => {
    const storeId = await storeWithSales([
      { daysAgo: 10, piastres: 3_000_000 },
      { daysAgo: 17, piastres: 3_000_000 },
      { daysAgo: 24, piastres: 3_000_000 },
      { daysAgo: 2, piastres: 1_000_000 },
    ]);
    await runProfitAnomalyScan(storeId);
    expect(await revenueDrop(storeId)).toMatchObject({ severity: 'p0' });
  });

  it('the baseline is the three weeks BEFORE the current week, not a window containing it', async () => {
    const storeId = await storeWithSales([
      { daysAgo: 10, piastres: 1_000_000 },
      { daysAgo: 17, piastres: 1_000_000 },
      { daysAgo: 24, piastres: 1_000_000 },
      { daysAgo: 2, piastres: 580_000 },
    ]);
    await runProfitAnomalyScan(storeId);
    const row = await revenueDrop(storeId);
    expect(row).toMatchObject({ severity: 'p0' });
    expect(Number(row!.baseline28d)).toBeCloseTo(1_000_000, 0);
  });
});
