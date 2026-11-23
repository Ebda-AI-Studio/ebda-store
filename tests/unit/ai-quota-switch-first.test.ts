/**
 * `assertAiQuota` asks the merchant's AI switch BEFORE it counts any usage: a store with AI off must cost no usage
 * query at all. Behaviour, not text order (replaces the `indexOf` check of layer 3 in
 * ai-entry-points-respect-switch.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  aiOn: true,
  calls: [] as string[],
}));

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  isStoreAiEnabled: async () => h.aiOn,
  assertStoreAiEnabled: async () => {
    h.calls.push('switch');
    if (!h.aiOn) throw Object.assign(new Error('off'), { code: 'AI_DISABLED_BY_MERCHANT' });
  },
  requireAiEnabled: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/lib/ai-plan-gate', () => ({
  assertStoreAiPlan: async () => undefined,
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    aiUsage: {
      count: async () => {
        h.calls.push('store-count');
        return 0;
      },
    },
  },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  countAiUsage: async () => {
    h.calls.push('platform-count');
    return 0;
  },
}));

import { assertAiQuota } from '../../apps/api/src/lib/ai-quota';

beforeEach(() => {
  h.calls = [];
});

describe('assertAiQuota asks the switch before it counts anything', () => {
  it('AI off: refuses, and no usage count ever runs', async () => {
    h.aiOn = false;
    await expect(assertAiQuota({ storeId: 's1' })).rejects.toMatchObject({
      code: 'AI_DISABLED_BY_MERCHANT',
    });
    expect(h.calls).toEqual(['switch']);
  });

  it('AI on: the switch is asked first, then the counts run (control)', async () => {
    h.aiOn = true;
    await assertAiQuota({ storeId: 's1' }).catch(() => undefined);
    expect(h.calls[0]).toBe('switch');
    expect(h.calls.filter(c => c.endsWith('count')).length).toBeGreaterThan(0);
  });
});
