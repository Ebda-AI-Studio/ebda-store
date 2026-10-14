/**
 * runCitationScan — step-retry resume (#910) and usage provenance (#1038).
 *
 * #910: the per-store scan runs inside one Inngest `step.run`. A crash after
 * writing some `AnswerEngineCheck` rows re-runs the whole step, which used to
 * re-issue every paid provider call and duplicate every row already written.
 * With `runStartedAt` (memoized per run), pairs this run already answered are
 * counted but neither re-queried nor re-written.
 *
 * #1038: the paid-engine usage row must carry the model the provider actually
 * called, so it is priced at that model's rate rather than GEMINI_MODEL's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindMany, mockCreate, mockRecordUsage } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockCreate: vi.fn(),
  mockRecordUsage: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: Record<string, any> = {
    prisma: {
      store: { findUnique: vi.fn().mockResolvedValue({ domain: 'shop.example', name: 'Shop' }) },
      answerEngineCheck: { findMany: mockFindMany, create: mockCreate },
    },
    // withSavepoint (lib/savepoint.ts) asks this; no request transaction here.
    hasTenantContext: () => false,
  };
  mod.withStore = (_id: string, fn: (tx: unknown) => unknown) => fn(mod.prisma);
  return mod;
});
vi.mock('@api/services/ai.service', () => ({ recordUsage: mockRecordUsage }));
vi.mock('@api/services/answer-engine/budget', () => ({
  isPaidEngineOverBudget: vi.fn().mockResolvedValue(false),
}));
vi.mock('@api/services/answer-engine/registry', () => ({ getEnabledProviders: vi.fn() }));
vi.mock('@api/services/answer-engine/prompts', () => ({ generatePrompts: vi.fn() }));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { runCitationScan } from '@api/services/answer-engine/citation-scan.service';
import type { AnswerEngineProvider } from '@api/services/answer-engine/provider';

const PROMPTS = [
  { text: 'best dates in kuwait', locale: 'en' as const },
  { text: 'best honey in kuwait', locale: 'en' as const },
  { text: 'افضل تمر', locale: 'ar' as const },
];

function provider(): AnswerEngineProvider & { query: ReturnType<typeof vi.fn> } {
  return {
    engine: 'perplexity',
    modelId: 'sonar-pro-test',
    query: vi.fn().mockResolvedValue({ text: 'answer', citedUrls: [] }),
  };
}

describe('runCitationScan', () => {
  beforeEach(() => {
    mockFindMany.mockReset().mockResolvedValue([]);
    mockCreate.mockReset().mockResolvedValue({});
    mockRecordUsage.mockReset().mockResolvedValue(undefined);
  });

  it('resumes a retried step: pairs this run already wrote are neither re-queried nor re-written', async () => {
    // The crashed first attempt wrote the first prompt's row.
    mockFindMany.mockResolvedValue([
      { engine: 'perplexity', promptText: 'best dates in kuwait', locale: 'en' },
    ]);
    const p = provider();
    const runStartedAt = new Date('2026-09-21T02:00:00.000Z');

    const [result] = await runCitationScan('store-1', {
      providers: [p],
      prompts: PROMPTS,
      runStartedAt,
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: 'store-1', runAt: { gte: runStartedAt } } })
    );
    expect(p.query).toHaveBeenCalledTimes(2);
    expect(p.query.mock.calls.map(c => c[1])).toEqual(['best honey in kuwait', 'افضل تمر']);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockRecordUsage).toHaveBeenCalledTimes(2);
    // The resumed pair still counts, so the run's totals are unchanged.
    expect(result.checks).toBe(3);
  });

  it('a same-text prompt in the other locale is still queried', async () => {
    mockFindMany.mockResolvedValue([
      { engine: 'perplexity', promptText: 'افضل تمر', locale: 'en' },
    ]);
    const p = provider();
    await runCitationScan('store-1', {
      providers: [p],
      prompts: PROMPTS,
      runStartedAt: new Date(),
    });
    expect(p.query).toHaveBeenCalledTimes(3);
  });

  it('without runStartedAt it queries every pair and does not read prior rows', async () => {
    const p = provider();
    await runCitationScan('store-1', { providers: [p], prompts: PROMPTS });
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(p.query).toHaveBeenCalledTimes(3);
  });

  it('records the paid-engine usage row against the model the provider called (#1038)', async () => {
    const p = provider();
    await runCitationScan('store-1', { providers: [p], prompts: PROMPTS.slice(0, 1) });
    expect(mockRecordUsage).toHaveBeenCalledWith(
      'store-1',
      'answer_engine_perplexity',
      0,
      0,
      false,
      { model: 'sonar-pro-test' }
    );
  });
});

/**
 * issue 2076 — the resume only works if each check row commits as it is
 * written. Both entrypoints must scope the scan per query (runInStoreScope),
 * never wrap the whole scan in one interactive transaction. The committed-vs-
 * rolled-back behaviour itself is proven against Postgres in
 * tests/integration/answer-engine/citation-scan.test.ts.
 */
describe('citation scan entrypoints never hold one transaction across the scan (issue 2076)', () => {
  it('answer-engine-citation-scan.ts calls runCitationScan only inside runInStoreScope', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(__dirname, '../../apps/api/src/lib/inngest/functions/answer-engine-citation-scan.ts'),
      'utf8'
    );
    const calls = src.match(/runIn\w+\(storeId, \(\) => runCitationScan\(/g) ?? [];
    expect(calls.length).toBe(2);
    expect(calls.every(c => c.startsWith('runInStoreScope('))).toBe(true);
    expect(src).not.toMatch(/runInTenantContext\(storeId, \(\) => runCitationScan/);
  });
});
