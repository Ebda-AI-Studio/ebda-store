import { describe, expect, it } from 'vitest';
import {
  activeMs,
  bannedInputProblems,
  budgetProblems,
  median,
  minSample,
  relativeProblems,
} from '../../scripts/ci/worker-startup-budget.mjs';
import budget from '../../scripts/ci/worker-startup-budget.json';
import webBudget from '../../scripts/ci/worker-startup-budget-web.json';
import adminBudget from '../../scripts/ci/worker-startup-budget-admin.json';

const ok = { startupCpuMs: 90, bundleBytes: 7_518_999, bundleGzipBytes: 2_171_018 };

describe('API Worker startup budget verdict', () => {
  it('the recorded post-fix baseline passes', () => {
    expect(budgetProblems(ok, budget)).toEqual([]);
  });
  it('the pre-fix startup CPU (164 ms) fails', () => {
    expect(budgetProblems({ ...ok, startupCpuMs: 164 }, budget)).toHaveLength(1);
  });
  it('each metric fails on its own', () => {
    expect(budgetProblems({ ...ok, bundleBytes: budget.bundleBytes + 1 }, budget)).toHaveLength(1);
    expect(
      budgetProblems({ ...ok, bundleGzipBytes: budget.bundleGzipBytes + 1 }, budget)
    ).toHaveLength(1);
  });
  it('a missing measurement (NaN) never passes', () => {
    expect(budgetProblems({ ...ok, startupCpuMs: NaN }, budget)).toHaveLength(1);
  });
  it('skipCpu leaves bundle gates in force but not the absolute CPU ceiling', () => {
    expect(budgetProblems({ ...ok, startupCpuMs: 189 }, budget, { skipCpu: true })).toEqual([]);
    expect(
      budgetProblems({ ...ok, bundleBytes: budget.bundleBytes + 1 }, budget, { skipCpu: true })
    ).toHaveLength(1);
  });
  it('relative: a loaded runner that slows both bundles equally passes', () => {
    expect(relativeProblems(189, 180, budget.relative)).toEqual([]);
  });
  it('relative: a 100 ms top-level loop on a 90 ms base fails', () => {
    expect(relativeProblems(190, 90, budget.relative)).toHaveLength(1);
  });
  it('relative: an unmeasured side never passes', () => {
    expect(relativeProblems(NaN, 90, budget.relative)).toHaveLength(1);
    expect(relativeProblems(90, 0, budget.relative)).toHaveLength(1);
  });
  it('activeMs sums every sample except (idle)', () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(idle)' } },
        { id: 2, callFrame: { functionName: 'x' } },
      ],
      samples: [1, 2, 2, 1],
      timeDeltas: [5000, 1000, 2000, 7000],
    };
    expect(activeMs(profile)).toBe(3);
  });
  it('median of odd and even sets', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('minSample: a profile that recorded nothing is not the fastest start', () => {
  it('ignores 0, negative and NaN samples (the #260 baseline: 127.8, 128.6, 0, 147.2, 124.9)', () => {
    expect(minSample([127.8, 128.6, 0, 147.2, 124.9])).toBe(124.9);
    expect(minSample([130, -1, NaN, 126.5])).toBe(126.5);
  });
  it('is 0 (not measured) only when no sample is real, and that still fails the relative verdict', () => {
    expect(minSample([])).toBe(0);
    expect(minSample([0, 0])).toBe(0);
    expect(relativeProblems(101, minSample([0, 0]), { ratio: 0.2, slackMs: 20 })).toHaveLength(1);
  });
  it('with the zero dropped, the PR from that run passes against its base', () => {
    const base = minSample([127.8, 128.6, 0, 147.2, 124.9]);
    const pr = minSample([109.7, 101.1, 112.5, 138.4, 104.2]);
    expect(relativeProblems(pr, base, { ratio: 0.2, slackMs: 20 })).toEqual([]);
  });
});

describe('banned bundle inputs (Ruling BUNDLE-BUDGET-9)', () => {
  const meta = (inputs: string[]) => ({
    outputs: {
      'out/worker.js': { inputs: Object.fromEntries(inputs.map(f => [f, { bytesInOutput: 1 }])) },
      'out/worker.js.map': { inputs: {} },
    },
  });
  it('the English locale and the locales index are allowed', () => {
    expect(
      bannedInputProblems(
        meta([
          '../../node_modules/zod/v4/locales/en.js',
          '../../node_modules/zod/v4/locales/index.js',
        ])
      )
    ).toEqual([]);
  });
  it('any other zod locale fails, once per class', () => {
    const problems = bannedInputProblems(
      meta(['../../node_modules/zod/v4/locales/he.js', '../../node_modules/zod/v4/locales/ru.js'])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^2 banned bundle input/);
  });
  it('a metafile without worker.js never passes', () => {
    expect(bannedInputProblems({ outputs: {} })).toHaveLength(1);
  });
});

describe('storefront (web) Worker budget, Ruling WEB-COLD-3', () => {
  const after = { startupCpuMs: 38.6, bundleBytes: 16_070_960, bundleGzipBytes: 3_221_014 };
  it('the slimmed bundle passes', () => {
    expect(budgetProblems(after, webBudget)).toEqual([]);
  });
  it('the old bundle (22.8 MB raw, 4.7 MB gzip, @sentry/nextjs in the server graph) fails both size gates', () => {
    expect(
      budgetProblems(
        { startupCpuMs: 38, bundleBytes: 22_813_353, bundleGzipBytes: 4_715_303 },
        webBudget
      )
    ).toHaveLength(2);
  });
});

describe('admin Worker startup budget (Ruling ADMIN-STARTUP-BUDGET-1)', () => {
  const measured = adminBudget.baseline.after;
  it('the first measurement (20.7 ms, 19.70 MB raw, 3.55 MB gzip) passes with headroom, not exactly at the ceiling', () => {
    expect(budgetProblems(measured, adminBudget)).toEqual([]);
    expect(adminBudget.startupCpuMs).toBeGreaterThan(measured.startupCpuMs * 2);
    expect(adminBudget.bundleBytes).toBeGreaterThan(measured.bundleBytes);
    expect(adminBudget.bundleBytes).toBeLessThan(measured.bundleBytes * 1.2);
  });
  it('a bundle one byte over, a gzip one byte over, or a startup over the ceiling each fail', () => {
    expect(
      budgetProblems({ ...measured, bundleBytes: adminBudget.bundleBytes + 1 }, adminBudget)
    ).toHaveLength(1);
    expect(
      budgetProblems({ ...measured, bundleGzipBytes: adminBudget.bundleGzipBytes + 1 }, adminBudget)
    ).toHaveLength(1);
    expect(
      budgetProblems({ ...measured, startupCpuMs: adminBudget.startupCpuMs + 1 }, adminBudget)
    ).toHaveLength(1);
  });
  it('relative mode keeps the shared ratio and slack', () => {
    expect(adminBudget.relative).toEqual({ ratio: 0.25, slackMs: 15 });
    expect(relativeProblems(60, 20.7, adminBudget.relative)).toHaveLength(1);
    expect(relativeProblems(30, 20.7, adminBudget.relative)).toEqual([]);
  });
});
