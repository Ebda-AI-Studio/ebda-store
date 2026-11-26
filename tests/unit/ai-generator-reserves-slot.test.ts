/**
 * #845 review: the per-product generators (`generateProductFaqs`, `generateProductMetaAeo`) reserve the store's slot
 * THEMSELVES and release it in a finally, so the per-product routes and the bulk sweeps are both covered and no caller
 * can reach the model behind a check-only quota. Two concurrent calls at cap-1 make exactly one model call, and a
 * failed model call gives its slot back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  rows: 0,
  modelCalls: 0,
  fail: false,
  tick: () => new Promise<void>(r => setTimeout(r, 1)),
}));

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  assertStoreAiEnabled: async () => undefined,
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
  prisma: { aiUsage: { count: async () => (await h.tick(), h.rows) } },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({ countAiUsage: async () => 0 }));
vi.mock('@api/services/ai.service', () => ({ recordUsage: async () => undefined }));
vi.mock('@api/lib/ai/gemini-keys', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/ai/gemini-keys')>()),
  GeminiFailoverClient: class {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          h.modelCalls++;
          await h.tick();
          if (h.fail) throw Object.assign(new Error('boom'), { status: 500 });
          return { response: { text: () => '{"en":"x","ar":"y"}', usageMetadata: {} } };
        },
      };
    }
  },
}));

import { generateProductMetaAeo } from '../../apps/api/src/lib/ai/product-meta-aeo-generator';
import { generateProductFaqs } from '../../apps/api/src/lib/ai/product-faq-generator';

const CAP = 150;
const aeo = () =>
  generateProductMetaAeo(
    { storeId: 's1', storeName: 'S', product: { name: 'Mug' }, bulk: true },
    'k',
    'm'
  );
const faqs = () =>
  generateProductFaqs(
    { storeId: 's1', storeName: 'S', product: { name: 'Mug' }, count: 1, bulk: true },
    'k',
    'm'
  );

beforeEach(() => {
  h.counters.clear();
  h.rows = CAP - 1;
  h.modelCalls = 0;
  h.fail = false;
  process.env.AI_STORE_DAILY_REQUEST_CAP = String(CAP);
  process.env.AI_DAILY_REQUEST_CAP = '100000';
});

describe('generators reserve the slot themselves', () => {
  it.each([
    ['generateProductMetaAeo', aeo],
    ['generateProductFaqs', faqs],
  ])('%s: two concurrent sweeps at cap-1 -> exactly one model call', async (_n, call) => {
    await Promise.allSettled([call(), call()]);
    expect(h.modelCalls).toBe(1);
  });

  it('a failed model call releases its slot: the next call at cap-1 still gets through', async () => {
    h.fail = true;
    await expect(aeo()).rejects.toBeTruthy();
    expect([...h.counters.values()].reduce((a, n) => a + n, 0)).toBe(0);
    h.fail = false;
    await aeo();
    expect(h.modelCalls).toBe(2);
  });
});
