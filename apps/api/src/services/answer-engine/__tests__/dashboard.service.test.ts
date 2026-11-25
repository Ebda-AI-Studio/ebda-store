import { describe, it, expect } from 'vitest';
import { aggregateAnswerEngineChecks } from '../dashboard.service';

// `aggregateAnswerEngineChecks` is the pure function `dashboard.service.ts`
// splits out specifically so it's unit-testable without a DB (see its own
// docstring) — the integration test at
// apps/api/workers-test/answer-engine-dashboard.test.ts exercises the full
// route; these tests cover the aggregation logic itself, in particular the
// new `groundingUnavailable` signal from issue #929.

type CheckRowInput = Parameters<typeof aggregateAnswerEngineChecks>[0][number];

function row(overrides: Partial<CheckRowInput> & { engine: string }): CheckRowInput {
  return {
    promptText: 'prompt',
    locale: 'en',
    cited: false,
    rank: null,
    snippet: null,
    citedUrls: [],
    competitorUrls: [],
    groundingUnavailableReason: null,
    runAt: new Date('2026-09-26T00:00:00Z'),
    ...overrides,
  };
}

describe('aggregateAnswerEngineChecks — groundingUnavailable (issue #929)', () => {
  it('is false when the engine grounded normally and cited something (no reason recorded)', () => {
    const summary = aggregateAnswerEngineChecks([
      row({ engine: 'gemini', cited: true, citedUrls: ['https://store.example/x'] }),
    ]);

    expect(summary.engines[0]).toMatchObject({
      engine: 'gemini',
      groundedCaveat: false,
      groundingUnavailable: false,
    });
  });

  it('is false (but groundedCaveat is true) when grounding ran fine and simply cited nothing', () => {
    // No groundingUnavailableReason — this is a REAL grounded run that found
    // no citation, categorically different from grounding being unavailable.
    const summary = aggregateAnswerEngineChecks([
      row({ engine: 'gemini', cited: false, citedUrls: [], groundingUnavailableReason: null }),
    ]);

    expect(summary.engines[0]).toMatchObject({
      groundedCaveat: true,
      groundingUnavailable: false,
    });
  });

  it('is true when the latest check recorded a groundingUnavailableReason (fallback to ungrounded)', () => {
    const summary = aggregateAnswerEngineChecks([
      row({
        engine: 'gemini',
        cited: false,
        citedUrls: [],
        groundingUnavailableReason: 'http_429',
      }),
    ]);

    expect(summary.engines[0]).toMatchObject({
      groundedCaveat: true,
      groundingUnavailable: true,
    });
  });

  it('is true if ANY of the latest-per-prompt checks for the engine carries a reason, not just all of them', () => {
    const now = new Date('2026-09-26T00:00:00Z');
    const summary = aggregateAnswerEngineChecks([
      row({
        engine: 'gemini',
        promptText: 'prompt A',
        groundingUnavailableReason: 'http_429',
        runAt: now,
      }),
      row({
        engine: 'gemini',
        promptText: 'prompt B',
        groundingUnavailableReason: null,
        runAt: now,
      }),
    ]);

    expect(summary.engines[0].groundingUnavailable).toBe(true);
  });

  it('never leaks a reason from an OLDER run once a newer check for the same prompt superseded it', () => {
    const older = new Date('2026-09-01T00:00:00Z');
    const newer = new Date('2026-09-26T00:00:00Z');
    // Rows arrive sorted `runAt desc` (as the real query returns them) — the
    // newer, reason-free row must win for "latest per prompt".
    const summary = aggregateAnswerEngineChecks([
      row({
        engine: 'gemini',
        promptText: 'best gadgets',
        cited: true,
        citedUrls: ['https://store.example/x'],
        groundingUnavailableReason: null,
        runAt: newer,
      }),
      row({
        engine: 'gemini',
        promptText: 'best gadgets',
        groundingUnavailableReason: 'http_429',
        runAt: older,
      }),
    ]);

    expect(summary.engines[0].groundingUnavailable).toBe(false);
  });

  it('does not affect other engines — Perplexity/OpenAI never set the reason', () => {
    const now = new Date('2026-09-26T00:00:00Z');
    const summary = aggregateAnswerEngineChecks([
      row({ engine: 'gemini', groundingUnavailableReason: 'http_429', runAt: now }),
      row({
        engine: 'perplexity',
        cited: true,
        citedUrls: ['https://store.example/x'],
        runAt: now,
      }),
    ]);

    const byEngine = Object.fromEntries(summary.engines.map(e => [e.engine, e]));
    expect(byEngine.gemini.groundingUnavailable).toBe(true);
    expect(byEngine.perplexity.groundingUnavailable).toBe(false);
  });

  it('returns an empty engines list for zero rows without throwing', () => {
    expect(aggregateAnswerEngineChecks([])).toEqual({
      engines: [],
      trend: [],
      prompts: [],
      lastRunAt: null,
    });
  });
});

describe('aggregateAnswerEngineChecks — latest run, not latest-per-prompt (issue 2118)', () => {
  it('a RETIRED prompt text carrying an old reason does not pin the banner', () => {
    // Prompt A was asked once, hit a 429, then the merchant re-ordered their
    // categories so it is never generated again. Prompt B is the live one.
    const summary = aggregateAnswerEngineChecks([
      row({
        engine: 'gemini',
        promptText: 'prompt B',
        cited: true,
        citedUrls: ['https://store.example/x'],
        runAt: new Date('2026-09-26T00:00:00Z'),
      }),
      row({
        engine: 'gemini',
        promptText: 'prompt A',
        groundingUnavailableReason: 'http_429',
        runAt: new Date('2026-06-01T00:00:00Z'),
      }),
    ]);

    expect(summary.engines[0].groundingUnavailable).toBe(false);
    expect(summary.engines[0].groundedCaveat).toBe(false);
  });

  it('a retired prompt with empty citedUrls does not hold the grounded caveat either', () => {
    const summary = aggregateAnswerEngineChecks([
      row({
        engine: 'gemini',
        promptText: 'prompt B',
        citedUrls: ['https://other.example/y'],
        runAt: new Date('2026-09-26T00:00:00Z'),
      }),
      row({ engine: 'gemini', promptText: 'prompt A', runAt: new Date('2026-06-01T00:00:00Z') }),
    ]);
    expect(summary.engines[0].groundedCaveat).toBe(false);
  });
});

describe('aggregateAnswerEngineChecks — ungrounded rows are not citations (issue 2120)', () => {
  it('leaves ungrounded fallback rows out of the cited arithmetic and the trend', () => {
    const now = new Date('2026-09-26T00:00:00Z');
    const summary = aggregateAnswerEngineChecks([
      // Grounded, cited.
      row({
        engine: 'gemini',
        promptText: 'a',
        cited: true,
        citedUrls: ['https://s/x'],
        runAt: now,
      }),
      // Grounded, not cited.
      row({ engine: 'gemini', promptText: 'b', citedUrls: ['https://o/y'], runAt: now }),
      // Ungrounded fallback that "cited" by brand substring.
      row({
        engine: 'gemini',
        promptText: 'c',
        cited: true,
        groundingUnavailableReason: 'http_429',
        runAt: now,
      }),
    ]);

    expect(summary.engines[0]).toMatchObject({
      totalChecks: 2,
      citedCount: 1,
      citedRate: 0.5,
      groundingUnavailable: true,
    });
    expect(summary.trend).toEqual([
      expect.objectContaining({ totalChecks: 2, citedCount: 1, citedRate: 0.5 }),
    ]);
  });

  it('an engine with only ungrounded rows reports an UNKNOWN rate, not 0%', () => {
    const summary = aggregateAnswerEngineChecks([
      row({ engine: 'gemini', cited: true, groundingUnavailableReason: 'http_429' }),
    ]);
    expect(summary.engines[0]).toMatchObject({
      totalChecks: 0,
      citedCount: 0,
      citedRate: null,
      groundingUnavailable: true,
    });
    expect(summary.trend).toEqual([]);
  });
});
