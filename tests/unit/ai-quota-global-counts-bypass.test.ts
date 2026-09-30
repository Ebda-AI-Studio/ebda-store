/**
 * issue 2040 / issue 2043 — the GLOBAL Gemini caps must count every store.
 *
 * `ai_usage` carries a STRICT RLS policy. `assertAiQuota` is called from
 * inside `runInStoreScope` (every bulk-AI sweep) and inside `tenantContext`
 * (the interactive AI routes), where an ambient `prisma.aiUsage.count()` is
 * filtered to the ONE store under force_app. The two platform counts
 * therefore have to run under `withRlsBypass`; only the per-store slice may
 * use the ambient (scoped) client.
 *
 * The fake below makes the two paths disagree the way force_app does: the
 * ambient client sees only this store's rows (0), the bypass sees the
 * platform total (500). Mutation-proof: moving the global counts back onto
 * `prisma.aiUsage.count` makes both "trips the global …" cases pass through
 * silently and redden.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  ambientCount: vi.fn(),
  bypassCount: vi.fn(),
  withRlsBypass: vi.fn(),
}));

vi.mock('@force/database', () => ({
  prisma: { aiUsage: { count: h.ambientCount } },
  withRlsBypass: h.withRlsBypass,
}));

import { assertAiQuota } from '../../apps/api/src/lib/ai-quota';

describe('assertAiQuota — global caps are cross-tenant (issue 2040, issue 2043)', () => {
  const env = { ...process.env };
  beforeEach(() => {
    h.ambientCount.mockReset().mockResolvedValue(0); // what one store's scope sees
    h.bypassCount.mockReset().mockResolvedValue(500); // the platform total
    h.withRlsBypass
      .mockReset()
      .mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({ aiUsage: { count: h.bypassCount } })
      );
    process.env.AI_DAILY_REQUEST_CAP = '450';
    process.env.AI_MONTHLY_REQUEST_CAP = '20000';
    process.env.AI_STORE_DAILY_REQUEST_CAP = '150';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('trips the global DAILY cap on the platform total, not the scoped store count', async () => {
    await expect(assertAiQuota({ storeId: 'store-a', bulk: true })).rejects.toMatchObject({
      code: 'AI_QUOTA_DAILY_EXCEEDED',
    });
    expect(h.withRlsBypass).toHaveBeenCalledTimes(1);
  });

  it('trips the global MONTHLY cap on the platform total', async () => {
    h.bypassCount.mockImplementation(async (args: { where: { createdAt: { gte: Date } } }) => {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      // daily count low, monthly count over cap
      return args.where.createdAt.gte.getTime() === monthStart.getTime() ? 25000 : 0;
    });
    await expect(assertAiQuota({ storeId: 'store-a' })).rejects.toMatchObject({
      code: 'AI_QUOTA_MONTHLY_EXCEEDED',
    });
  });

  it('keeps the per-store slice on the ambient (store-scoped) client', async () => {
    h.bypassCount.mockResolvedValue(0);
    h.ambientCount.mockResolvedValue(150);
    await expect(assertAiQuota({ storeId: 'store-a' })).rejects.toMatchObject({
      code: 'AI_QUOTA_STORE_DAILY_EXCEEDED',
    });
    expect(h.ambientCount).toHaveBeenCalledTimes(1);
    expect(h.ambientCount.mock.calls[0][0]).toMatchObject({ where: { storeId: 'store-a' } });
  });
});
