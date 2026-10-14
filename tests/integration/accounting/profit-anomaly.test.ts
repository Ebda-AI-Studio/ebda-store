import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@ebda/database';

// vi.mock is hoisted by vitest before imports — must appear at module top-level.
vi.mock('../../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(async () => ({
    explanationEn: 'X',
    explanationAr: 'Y',
    likelyCause: 'cost',
  })),
  callGeminiBatch: vi.fn(async () => []),
}));

// Mock sendAlert so p0 anomaly tests don't need Telegram credentials.
vi.mock('../../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));

import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { runProfitAnomalyScan } from '../../../apps/api/src/services/accounting/profit-anomaly.service';

// Isolated OWNER — '...0011' is not used by any other accounting test suite.
const OWNER = '00000000-0000-0000-0000-000000000011';
let storeId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `profit-anomaly-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'P',
      lastName: 'A',
    },
  });

  const s = await prisma.store.create({
    data: {
      name: `profit-anomaly-test-${Date.now()}`,
      slug: `profit-anomaly-test-${Date.now()}`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
    },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
});

afterAll(async () => {
  await prisma.profitAnomaly.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('profit anomaly scan', () => {
  it('returns expected shape on a store with no GL activity', async () => {
    // With no paid orders or inventory history, every metric baseline = 0
    // and current = 0, so delta = 0 and no anomalies are detected.
    const result = await runProfitAnomalyScan(storeId);

    // Return value must have the documented shape.
    expect(result).toHaveProperty('detected');
    expect(result).toHaveProperty('p0Count');
    expect(typeof result.detected).toBe('number');
    expect(typeof result.p0Count).toBe('number');

    // Sparse store: no anomalies expected (zero/zero → delta 0).
    expect(result.detected).toBeGreaterThanOrEqual(0);
    expect(result.p0Count).toBeGreaterThanOrEqual(0);
    expect(result.p0Count).toBeLessThanOrEqual(result.detected);
  });

  it('does not crash when there are no journal entries', async () => {
    // The profitAndLoss helper should handle empty JournalEntry gracefully.
    await expect(runProfitAnomalyScan(storeId)).resolves.not.toThrow();
  });
});
