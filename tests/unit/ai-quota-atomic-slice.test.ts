/**
 * #845 (Ruling AI-SLICE-ATOMIC-1): the per-store daily AI slice is reserved atomically BEFORE the model call, so 20
 * parallel calls at cap-1 yield exactly one success. The old check-then-act counted `ai_usage` rows (written after the
 * call) and let all 20 through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const counters = new Map<string, number>();
  return {
    counters,
    rows: 0,
    // a real await between increment and read, so interleaving is genuine
    tick: () => new Promise<void>(r => setTimeout(r, 1)),
  };
});

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  assertStoreAiEnabled: async () => undefined,
}));
vi.mock('../../apps/api/src/lib/ai-plan-gate', () => ({
  assertStoreAiPlan: async () => undefined,
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    incrementRateLimit: async (k: string) => {
      const n = (h.counters.get(k) ?? 0) + 1;
      h.counters.set(k, n);
      await h.tick();
      return n;
    },
    getRateLimitCount: async (k: string) => h.counters.get(k) ?? 0,
    decrementRateLimit: async (k: string) => {
      const n = (h.counters.get(k) ?? 0) - 1;
      if (n <= 0) h.counters.delete(k);
      else h.counters.set(k, n);
    },
  },
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    aiUsage: {
      count: async () => {
        await h.tick();
        return h.rows;
      },
    },
  },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({ countAiUsage: async () => 0 }));

import { assertAiQuota } from '../../apps/api/src/lib/ai-quota';
import { releaseStoreSlot } from '../../apps/api/src/lib/ai-store-reservation';

const CAP = 150;
const settle = (n: number) =>
  Promise.allSettled(Array.from({ length: n }, () => assertAiQuota({ storeId: 's1' })));
const ok = (r: PromiseSettledResult<void>[]) => r.filter(x => x.status === 'fulfilled').length;

beforeEach(() => {
  h.counters.clear();
  h.rows = 0;
  process.env.AI_STORE_DAILY_REQUEST_CAP = String(CAP);
  process.env.AI_DAILY_REQUEST_CAP = '100000';
});

describe('per-store daily slice is atomic', () => {
  it('20 parallel calls at cap-1 -> exactly 1 succeeds, the rest get the store-cap 429', async () => {
    h.rows = CAP - 1;
    const r = await settle(20);
    expect(ok(r)).toBe(1);
    for (const x of r) {
      if (x.status === 'rejected')
        expect(x.reason).toMatchObject({ statusCode: 429, code: 'AI_QUOTA_STORE_DAILY_EXCEEDED' });
    }
  });

  it('far below the cap, parallel calls all pass (no false refusals)', async () => {
    h.rows = 10;
    expect(ok(await settle(20))).toBe(20);
  });

  it('a refused call gives its slot back: at the cap everything is refused, then cap-1 admits one', async () => {
    h.rows = CAP;
    expect(ok(await settle(5))).toBe(0);
    h.rows = CAP - 1;
    expect(ok(await settle(5))).toBe(1);
  });

  it('releasing a held slot (recordUsage does this once the row exists) frees room', async () => {
    h.rows = CAP - 2;
    expect(ok(await settle(3))).toBe(2); // two held
    await releaseStoreSlot('s1');
    await releaseStoreSlot('s1');
    expect(ok(await settle(3))).toBe(2);
  });

  it('release without a held slot is a no-op (a cached-hit record must not free someone else)', async () => {
    h.rows = CAP - 1;
    await releaseStoreSlot('s1');
    expect(ok(await settle(3))).toBe(1);
  });
});
