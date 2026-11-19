/**
 * AI tool run estimate = what a real run charges (lib/ai-run-estimate.ts is the ONE formula).
 *  1. The formula, per tool, on fixed counts.
 *  2. Every catalogue sweep sets its job total through `aiRunTotal` and takes its work set from the shared scopes, so
 *     the estimate route and the job cannot disagree (static: reads the job sources, like the other ratchets).
 *  3. A REAL excerpt sweep over N blank products makes exactly the number of model calls the estimate promised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AI_RUN_TOOLS,
  aiRunCalls,
  aiRunTotal,
  leavesOf,
  productScope,
  type AiRunTool,
} from '@api/lib/ai-run-estimate';

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../apps/api/src/config', () => ({ config: { googleAiKey: 'fake-key' } }));
vi.mock('../../apps/api/src/lib/ai-quota', () => ({
  assertAiQuota: vi.fn().mockResolvedValue(undefined),
  isAiQuotaCapError: () => false,
}));
vi.mock('../../apps/api/src/lib/inngest/ai-retry', () => ({
  callWithRetry: (fn: () => unknown) => fn(),
}));
const mockGenerateProductExcerpt = vi.fn();
vi.mock('../../apps/api/src/lib/ai/product-excerpt-generator', () => ({
  generateProductExcerpt: (...a: unknown[]) => mockGenerateProductExcerpt(...a),
}));
const mockFindManyProduct = vi.fn();
const mockUpdateJob = vi.fn();
vi.mock('@ebda/database', () => ({
  runInStoreScope: (_s: string, fn: () => unknown) => fn(),
  prisma: {
    store: { findUnique: async () => ({ name: 'S' }) },
    product: { findMany: (...a: unknown[]) => mockFindManyProduct(...a), update: vi.fn() },
    bulkAiJob: {
      findUnique: async () => ({ status: 'running' }),
      update: (...a: unknown[]) => mockUpdateJob(...a),
    },
  },
}));
let capturedHandler: (a: {
  event: { data: unknown };
  step: { run: (id: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<void>;
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_c: unknown, h: typeof capturedHandler) => {
      capturedHandler = h;
      return { id: 'x' };
    },
  },
}));

const COUNTS = { products: 7, categories: 3 };

describe('formula', () => {
  const calls = (t: AiRunTool) => leavesOf(t).reduce((n, l) => n + aiRunCalls(l, COUNTS), 0);
  it.each([
    ['translate-ar', (7 + 3 + 1) * 2],
    ['translate-en', (7 + 3 + 1) * 2],
    ['seo', 1 + 3 + 7],
    ['meta-aeo', 1 + 3 + 7],
    ['balance-descriptions', 7],
    ['revert-balance', 0], // undoing a balance run calls no model
    ['product-faqs', 7],
    ['recommendations', 7],
    ['citation-copy', 7],
    ['categorize', 7],
    ['image-alt', 7 * 4], // one call per image, up to 4 per product
    ['excerpt', 7],
    ['tags', 7],
    ['llms-txt', 1],
    ['brand-facts', 1],
    ['faq-aeo', 8],
    ['howto-aeo', 3],
    ['aeo-all', 8 + 3 + (1 + 3 + 7)],
    ['geo-all', 1 + 7 + 1],
  ] as [AiRunTool, number][])('%s uses up to %i calls', (tool, expected) => {
    expect(calls(tool)).toBe(expected);
  });
  it('covers every tool the page can start', () => {
    expect(AI_RUN_TOOLS.length).toBe(19);
    for (const t of AI_RUN_TOOLS) expect(calls(t)).toBeGreaterThanOrEqual(0);
  });
  it('a master sweep is the sum of its three tools', () => {
    expect(leavesOf('aeo-all')).toEqual(['faq-aeo', 'howto-aeo', 'meta-aeo']);
    expect(leavesOf('geo-all')).toEqual(['llms-txt', 'citation-copy', 'brand-facts']);
  });
});

describe('every sweep prices its work through the shared formula', () => {
  const dir = join(__dirname, '..', '..', 'apps', 'api', 'src', 'lib', 'inngest', 'functions');
  const jobs = readdirSync(dir).filter(f => /^bulk-ai-.*\.ts$/.test(f));
  // faq/howto/llms-txt/brand-facts totals are the request's own constants, not counted rows
  const FIXED = new Set(['bulk-ai-geo.ts', 'bulk-ai-aeo.ts']);
  it('no sweep sets `total` from a raw row count', () => {
    const offenders: string[] = [];
    for (const f of jobs) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/total:\s*([^,}\n]+(?:\([^)]*\))?[^,}\n]*)/g)) {
        const expr = m[1];
        if (/\.length/.test(expr) && !/aiRunTotal/.test(expr))
          offenders.push(`${f}: total: ${expr}`);
      }
      if (/where:\s*\{\s*storeId,\s*(status|deletedAt)/.test(src) && !FIXED.has(f)) {
        // a sweep's own product/category read must come from the shared scopes
        offenders.push(`${f}: inline product/category scope`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('the scoped sweeps import the shared module', () => {
    for (const f of jobs.filter(j => !['bulk-ai-geo.ts', 'bulk-ai-aeo.ts'].includes(j))) {
      const src = readFileSync(join(dir, f), 'utf8');
      if (/product\.findMany/.test(src) && /total:/.test(src))
        expect(src, f).toContain("from '../../ai-run-estimate'");
    }
  });
  it('scopes always carry the tenant', () => {
    expect(productScope.live('s1').storeId).toBe('s1');
    expect(productScope.active('s1').storeId).toBe('s1');
    expect(productScope.uncategorised('s1').storeId).toBe('s1');
  });
});

describe('a real excerpt sweep makes the calls the estimate promised', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.AI_BULK_THROTTLE_MS = '0';
    mockGenerateProductExcerpt.mockReset();
    mockFindManyProduct.mockReset();
    mockUpdateJob.mockReset().mockResolvedValue({});
    await import('../../apps/api/src/lib/inngest/functions/bulk-ai-excerpt.js');
  });
  it('N blank products: estimate = job total = model calls', async () => {
    const N = 5;
    const rows = Array.from({ length: N }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      nameAr: null,
      description: 'A long description.',
      descriptionAr: null,
      excerpt: null,
      excerptAr: null,
      aiFieldSources: {},
    }));
    mockFindManyProduct.mockResolvedValue(rows);
    mockGenerateProductExcerpt.mockResolvedValue({ excerpt: 'x', excerptAr: 'س' });
    const step = { run: (_id: string, fn: () => unknown) => Promise.resolve(fn()) };
    await capturedHandler({ event: { data: { jobId: 'j', storeId: 's1' } }, step });

    const estimate = aiRunCalls('excerpt', { products: N, categories: 0 });
    const totals = mockUpdateJob.mock.calls
      .map(c => (c[0] as { data: { total?: number } }).data.total)
      .filter((t): t is number => typeof t === 'number');
    expect(totals).toEqual([estimate]);
    expect(mockGenerateProductExcerpt).toHaveBeenCalledTimes(estimate);
    // the sweep read its products with the shared scope
    const where = (mockFindManyProduct.mock.calls[0][0] as { where: unknown }).where;
    expect(where).toEqual(productScope.active('s1'));
  });
});
