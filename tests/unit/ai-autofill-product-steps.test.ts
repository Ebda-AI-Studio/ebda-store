/**
 * Task 8 review I2: the `product.upserted` autofill must not hold a database transaction across
 * Gemini calls (a 30 s tenant transaction that rolled back every write AND every usage row when
 * slow), and an Inngest retry must not pay for a generation twice. The handler runs three
 * memoized steps: read (one short transaction) → generate (store scope, no transaction) → write
 * (one short, guarded transaction).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  isStoreAiEnabled: async () => true,
  assertStoreAiEnabled: async () => undefined,
  requireAiEnabled: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

/** true while a (fake) tenant transaction is open */
let inTx = false;
const events: string[] = [];
let productRow: Record<string, unknown>;
const updateSpy = vi.fn(async () => ({}));
vi.mock('@ebda/database', () => {
  const prisma = {
    product: {
      findFirst: vi.fn(async () => {
        events.push(`read:${inTx ? 'tx' : 'no-tx'}`);
        return productRow;
      }),
      update: (...a: unknown[]) => updateSpy(...(a as [])),
    },
    category: { findMany: vi.fn(async () => []) },
    productCategory: { createMany: vi.fn() },
    store: { findUnique: vi.fn(async () => ({ name: 'Shop', nameAr: 'متجر', theme: {} })) },
    $queryRaw: vi.fn(async () => []),
  };
  return {
    prisma,
    withStore: async (_id: string, fn: (tx: unknown) => unknown) => fn(prisma),
    hasTenantContext: () => inTx,
    runInTenantContext: async (_s: string, fn: () => Promise<unknown>) => {
      const was = inTx;
      inTx = true;
      try {
        return await fn();
      } finally {
        inTx = was;
      }
    },
    runInStoreScope: async (_s: string, fn: () => Promise<unknown>) => fn(),
    onClosedTenantTxAccess: vi.fn(),
  };
});
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(), createFunction: vi.fn(() => ({})) },
}));
const translate = vi.fn(async () => {
  events.push(`ai:${inTx ? 'tx' : 'no-tx'}`);
  return { translation: 'Leather sneakers', cached: false };
});
vi.mock('../../apps/api/src/services/ai.service', () => ({
  AIService: {
    translate: (...a: unknown[]) => translate(...(a as [])),
    suggestSeo: vi.fn(),
    suggestCategories: vi.fn(),
  },
}));
vi.mock('../../apps/api/src/config', () => ({ config: { googleAiKey: 'test-key' } }));
const generate = vi.fn(async () => {
  events.push(`ai:${inTx ? 'tx' : 'no-tx'}`);
  return 'جزمه, gazma';
});
vi.mock('../../apps/api/src/lib/ai/product-search-terms-generator', () => ({
  generateProductSearchTerms: (...a: unknown[]) => generate(...(a as [])),
}));

const { handleAiAutofillProduct } =
  await import('../../apps/api/src/lib/inngest/functions/ai-autofill-product');

const STORE = '11111111-1111-1111-1111-111111111111';
const PRODUCT = '22222222-2222-2222-2222-222222222222';
const human = {
  nameAr: 'human',
  description: 'human',
  descriptionAr: 'human',
  metaTitle: 'human',
  metaTitleAr: 'human',
  metaDescription: 'human',
  metaDescriptionAr: 'human',
};
const event = { data: { storeId: STORE, productId: PRODUCT, op: 'create' } };

/** A fake Inngest `step`: memoizes each step's output by name, like the real executor. */
function fakeStep(memo = new Map<string, unknown>()) {
  const names: string[] = [];
  return {
    names,
    memo,
    run: async (name: string, fn: () => Promise<unknown>) => {
      names.push(name);
      if (memo.has(name)) return memo.get(name);
      const v = JSON.parse(JSON.stringify((await fn()) ?? null)); // step output is JSON
      memo.set(name, v);
      return v;
    },
  };
}

beforeEach(() => {
  inTx = false;
  events.length = 0;
  updateSpy.mockReset();
  updateSpy.mockResolvedValue({});
  translate.mockClear();
  generate.mockClear();
  productRow = {
    id: PRODUCT,
    storeId: STORE,
    name: '',
    nameAr: 'كوتشي جلد',
    description: 'd',
    descriptionAr: 'و',
    metaTitle: 't',
    metaTitleAr: 't',
    metaDescription: 'd',
    metaDescriptionAr: 'd',
    searchTerms: null,
    aiFieldSources: { ...human },
    categories: [{ categoryId: 'c1' }],
  };
});

describe('ai-autofill-product (I2)', () => {
  it('runs read → generate → write as separate steps', async () => {
    const step = fakeStep();
    await handleAiAutofillProduct({ event, step } as never);
    expect(step.names).toEqual(['read', 'generate', 'write']);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('reads inside a transaction and makes every AI call outside one', async () => {
    await handleAiAutofillProduct({ event, step: fakeStep() } as never);
    expect(events.filter(e => e.startsWith('ai:'))).toEqual(['ai:no-tx', 'ai:no-tx']);
    expect(events[0]).toBe('read:tx');
  });

  it('a retry after a failed write reuses the memoized generation (no second paid call)', async () => {
    const memo = new Map<string, unknown>();
    updateSpy.mockRejectedValueOnce(new Error('connection reset'));
    await expect(handleAiAutofillProduct({ event, step: fakeStep(memo) } as never)).rejects.toThrow(
      'connection reset'
    );
    await handleAiAutofillProduct({ event, step: fakeStep(memo) } as never); // Inngest retry
    expect(translate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect((updateSpy.mock.calls[1] as unknown as [{ data: object }])[0].data).toMatchObject({
      name: 'Leather sneakers',
      searchTerms: 'جزمه, gazma',
    });
  });

  it('autopilot off: no generate step at all', async () => {
    productRow = { ...productRow };
    const { prisma } = await import('@ebda/database');
    vi.mocked(prisma.store.findUnique).mockResolvedValueOnce({
      theme: { aiAutopilot: false },
    } as never);
    const step = fakeStep();
    await handleAiAutofillProduct({ event, step } as never);
    expect(step.names).toEqual(['read']);
    expect(translate).not.toHaveBeenCalled();
  });
});
