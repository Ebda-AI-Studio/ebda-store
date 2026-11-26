/**
 * G72 backfill: the daily sweep puts the Franco spellings of a product's Arabic name into search
 * words the AI wrote earlier, and never into a merchant's own words (NEVER-OVERWRITE-1).
 * Fails on main (topUpFrancoSearchTerms does not exist).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let row: Record<string, unknown>;
const update = vi.fn(async (_a: unknown) => ({}));
vi.mock('@api/lib/store-ai-switch', () => ({
  isStoreAiEnabled: async () => true,
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@ebda/database', () => ({
  prisma: { $queryRaw: async () => [] },
  hasTenantContext: () => true,
  runInTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  onClosedTenantTxAccess: vi.fn(),
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => ({
    product: { findFirst: async () => ({ ...row, categories: [] }) },
  }),
  storeWriter: async () => ({ product: { update } }),
  storeRepo: async () => ({ backend: 'pg' }),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('../../apps/api/src/services/ai.service', () => ({ AIService: {} }));
vi.mock('../../apps/api/src/lib/search/reindex', () => ({
  requestStoreReindex: vi.fn(),
  touchesEmbedDoc: () => false,
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({ invalidateStoreProductCaches: vi.fn() }));

const { topUpFrancoSearchTerms } = await import('../../apps/api/src/services/ai-autofill.service');

const base = { name: '', nameAr: 'إسورة الشط', searchTerms: 'bracelet, اسوره' };

describe('topUpFrancoSearchTerms (G72 backfill)', () => {
  beforeEach(() => update.mockClear());

  it('adds the Franco spellings to AI-written words, keeping the AI words', async () => {
    row = { ...base, aiFieldSources: { searchTerms: 'ai' } };
    expect(await topUpFrancoSearchTerms('s1', 'p1')).toBe(true);
    const data = (update.mock.calls[0]![0] as { data: { searchTerms: string } }).data;
    expect(data.searchTerms).toContain('eswera');
    expect(data.searchTerms).toContain('bracelet');
  });

  it('never touches a merchant-owned or legacy (no provenance) word list', async () => {
    row = { ...base, aiFieldSources: { searchTerms: 'human' } };
    expect(await topUpFrancoSearchTerms('s1', 'p1')).toBe(false);
    row = { ...base, aiFieldSources: {} };
    expect(await topUpFrancoSearchTerms('s1', 'p1')).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('is idempotent: a list that already has the spellings is not rewritten', async () => {
    row = { ...base, aiFieldSources: { searchTerms: 'ai' } };
    await topUpFrancoSearchTerms('s1', 'p1');
    const written = (update.mock.calls[0]![0] as { data: { searchTerms: string } }).data
      .searchTerms;
    update.mockClear();
    row = { ...base, searchTerms: written, aiFieldSources: { searchTerms: 'ai' } };
    expect(await topUpFrancoSearchTerms('s1', 'p1')).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('leaves a product with no words to the normal fill', async () => {
    row = { ...base, searchTerms: null, aiFieldSources: {} };
    expect(await topUpFrancoSearchTerms('s1', 'p1')).toBe(false);
  });
});
