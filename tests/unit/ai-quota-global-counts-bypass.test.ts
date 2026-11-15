/**
 * issue 2040 / issue 2043 — the GLOBAL Gemini caps must count every store.
 *
 * `ai_usage` carries a STRICT RLS policy. `assertAiQuota` is called from
 * inside `runInStoreScope` (every bulk-AI sweep) and inside `tenantContext`
 * (the interactive AI routes), where an ambient `prisma.aiUsage.count()` is
 * filtered to the ONE store under ebda_app. The two platform counts
 * therefore go through the `ebda_ai_usage_count` SECURITY DEFINER function
 * (`countAiUsage`); only the per-store slice may use the ambient (scoped) client.
 *
 * The fake below makes the two paths disagree the way ebda_app does: the
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

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  isStoreAiEnabled: async () => true,
  assertStoreAiEnabled: async () => undefined,
  requireAiEnabled: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/lib/ai-plan-gate', () => ({
  assertStoreAiPlan: async () => undefined,
}));
vi.mock('@ebda/database', () => ({
  prisma: { aiUsage: { count: h.ambientCount } },
}));
// The two platform counts go through the SECURITY DEFINER `ebda_ai_usage_count` (a single
// aggregate across stores); `bypassCount` stands for it.
vi.mock('../../apps/api/src/lib/definer', () => ({
  countAiUsage: (o: { since: Date }) => h.withRlsBypass(o),
}));

import { assertAiQuota } from '../../apps/api/src/lib/ai-quota';

describe('assertAiQuota — global caps are cross-tenant (issue 2040, issue 2043)', () => {
  const env = { ...process.env };
  beforeEach(() => {
    h.ambientCount.mockReset().mockResolvedValue(0); // what one store's scope sees
    h.bypassCount.mockReset().mockResolvedValue(500); // the platform total
    h.withRlsBypass
      .mockReset()
      .mockImplementation(async (o: { since: Date }) =>
        h.bypassCount({ where: { createdAt: { gte: o.since } } })
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
    expect(h.withRlsBypass).toHaveBeenCalled(); // the platform count, not the ambient one
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
