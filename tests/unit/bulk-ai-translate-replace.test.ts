/**
 * bulk-ai-translate is fill-only for every caller (NEVER-OVERWRITE-1, Ruling RF-833-2):
 *  - a pair with both sides filled is never touched, with or without `force` on the event
 *  - an empty target is still a plain fill; the store's own name is never replaced
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/ai-quota', () => ({ isAiQuotaCapError: () => false }));
vi.mock('../../apps/api/src/lib/inngest/ai-retry', () => ({
  callWithRetry: (fn: () => unknown) => fn(),
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateStoreProductCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../apps/api/src/lib/search/reindex', () => ({
  requestStoreReindex: vi.fn().mockResolvedValue(undefined),
}));
const mockTranslate = vi.fn();
vi.mock('../../apps/api/src/services/ai.service', () => ({
  AIService: { translate: (...a: unknown[]) => mockTranslate(...a) },
}));
const mockReplace = vi.fn();
vi.mock('../../apps/api/src/services/catalogue-replace-backup.service', () => ({
  replaceTextWithBackup: (...a: unknown[]) => mockReplace(...a),
}));

const m = vi.hoisted(() => ({
  product: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  category: { findMany: vi.fn() },
  store: { findUnique: vi.fn() },
  job: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('@ebda/database', () => ({
  runInStoreScope: (_s: string, fn: () => unknown) => fn(),
  prisma: {
    product: m.product,
    category: m.category,
    store: m.store,
    bulkAiJob: m.job,
  },
}));

let handler: (a: {
  event: { data: unknown };
  step: { run: (id: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<void>;
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_c: unknown, h: typeof handler) => {
      handler = h;
      return { id: 'bulk-ai-translate' };
    },
  },
}));

beforeEach(async () => {
  vi.resetModules();
  process.env.AI_BULK_THROTTLE_MS = '0';
  for (const f of [
    mockTranslate,
    mockReplace,
    m.product.findMany,
    m.product.findUnique,
    m.product.update,
    m.category.findMany,
    m.store.findUnique,
    m.job.findUnique,
    m.job.update,
  ])
    f.mockReset();
  m.product.findMany.mockResolvedValue([{ id: 'p1' }]);
  m.category.findMany.mockResolvedValue([]);
  m.store.findUnique.mockResolvedValue(null);
  m.job.findUnique.mockResolvedValue({ status: 'running', userId: 'u1' });
  m.job.update.mockResolvedValue({});
  m.product.update.mockResolvedValue({});
  mockTranslate.mockResolvedValue({ translation: 'ترجمة جديدة' });
  mockReplace.mockResolvedValue('replaced');
  await import('../../apps/api/src/lib/inngest/functions/bulk-ai-translate.js');
});

const run = (data: Record<string, unknown>) =>
  handler({
    event: { data: { jobId: 'job-1', storeId: 's1', ...data } },
    step: { run: (_id, fn) => Promise.resolve(fn()) },
  });

const BOTH = { id: 'p1', name: 'Tee', nameAr: 'تيشرت', description: null, descriptionAr: null };

describe('translate: replace existing', () => {
  it('force off: both sides filled -> nothing translated, nothing written', async () => {
    m.product.findUnique.mockResolvedValue(BOTH);
    await run({ direction: 'to_ar' });
    expect(mockTranslate).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(m.product.update).not.toHaveBeenCalled();
  });

  it('force on is ignored: both sides filled -> nothing translated, nothing written (NEVER-OVERWRITE-1)', async () => {
    m.product.findUnique.mockResolvedValue(BOTH);
    await run({ direction: 'to_ar', force: true });
    expect(mockTranslate).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(m.product.update).not.toHaveBeenCalled();
  });

  it('force on, to_en: the English text is untouched too', async () => {
    m.product.findUnique.mockResolvedValue(BOTH);
    await run({ direction: 'to_en', force: true });
    expect(mockTranslate).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(m.product.update).not.toHaveBeenCalled();
  });

  it('an empty target is a plain fill even with force (no backup needed)', async () => {
    m.product.findUnique.mockResolvedValue({ ...BOTH, nameAr: null });
    await run({ direction: 'to_ar', force: true });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(m.product.update).toHaveBeenCalledWith({
      where: { id: 'p1', storeId: 's1' },
      data: { nameAr: 'ترجمة جديدة' },
    });
  });
});
