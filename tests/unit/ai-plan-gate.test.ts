/**
 * Ruling AI-PLAN-GATE-1 (#844): AI spend needs a paid (or trialing/comped) plan. `assertAiQuota` refuses a store whose
 * effective plan is `free` (never subscribed, or canceled) with 402 and a bilingual message, BEFORE any usage count.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  ent: null as null | { status: string; planCode: string },
  counts: 0,
}));

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  assertStoreAiEnabled: async () => undefined,
}));
vi.mock('../../apps/api/src/services/plan-entitlements', () => ({
  getEntitlements: async () => h.ent,
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    aiUsage: {
      count: async () => {
        h.counts++;
        return 0;
      },
    },
  },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  countAiUsage: async () => {
    h.counts++;
    return 0;
  },
}));

import { assertAiQuota, isAiQuotaCapError } from '../../apps/api/src/lib/ai-quota';

beforeEach(() => {
  h.counts = 0;
  h.ent = null;
});

describe('assertAiQuota plan gate', () => {
  it.each([
    ['canceled (falls back to free)', { status: 'canceled', planCode: 'free' }],
    ['no subscription, legacy free', { status: 'none', planCode: 'free' }],
    ['active on free', { status: 'active', planCode: 'free' }],
    ['unreadable store', null],
  ])('refuses %s with 402 + bilingual message, no usage count', async (_n, ent) => {
    h.ent = ent;
    const err = await assertAiQuota({ storeId: 's1' }).catch(e => e);
    expect(err).toMatchObject({ statusCode: 402, code: 'AI_PLAN_REQUIRED' });
    expect(err.details.messageEn).toMatch(/paid plan/);
    expect(err.details.messageAr).toMatch(/[؀-ۿ]/);
    expect(h.counts).toBe(0);
    expect(isAiQuotaCapError(err)).toBe(true);
  });

  it.each([
    ['trialing on free', { status: 'trialing', planCode: 'free' }],
    ['comped on free', { status: 'comped', planCode: 'free' }],
    ['active growth', { status: 'active', planCode: 'growth' }],
    ['past_due growth (grace)', { status: 'past_due', planCode: 'growth' }],
    ['legacy paid, no subscription', { status: 'none', planCode: 'starter' }],
  ])('allows %s (counts run)', async (_n, ent) => {
    h.ent = ent;
    await expect(assertAiQuota({ storeId: 's1' })).resolves.toBeUndefined();
    expect(h.counts).toBeGreaterThan(0);
  });

  it('a no-storeId (platform) call is not plan-gated', async () => {
    h.ent = { status: 'canceled', planCode: 'free' };
    await expect(assertAiQuota()).resolves.toBeUndefined();
  });
});
