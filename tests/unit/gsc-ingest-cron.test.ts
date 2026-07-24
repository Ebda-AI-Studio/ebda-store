/**
 * Unit test for the `gscIngestCron`'s dormancy guard (Plan 8B, Task 3).
 *
 * With `isGscConfigured()` false (no `GSC_SERVICE_ACCOUNT_JSON` set), the
 * cron must log + return immediately WITHOUT enumerating any stores —
 * `withRlsBypass` (the `list-stores` step) must never be called. Mirrors
 * the `createFunction`-capture pattern used by
 * tests/unit/bulk-ai-excerpt-sweep.test.ts so the handler can be invoked
 * directly without a running Inngest server or a real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const mockIsGscConfigured = vi.fn();
vi.mock('../../apps/api/src/services/answer-engine/gsc-client', () => ({
  isGscConfigured: (...args: unknown[]) => mockIsGscConfigured(...args),
}));

const mockWithRlsBypass = vi.fn();
vi.mock('@force/database', () => ({
  withRlsBypass: (...args: unknown[]) => mockWithRlsBypass(...args),
  runInTenantContext: vi.fn(),
}));

vi.mock('../../apps/api/src/services/answer-engine/gsc-ingest.service', () => ({
  runGscIngest: vi.fn(),
}));

vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn() },
}));

vi.mock('../../apps/api/src/lib/ai-plan-eligibility', () => ({
  aiEligiblePlanFilter: { plan: { notIn: ['free'] } },
  isAiEligiblePlan: (plan: string) => plan !== 'free',
}));

let capturedCronHandler: (args: {
  step: { run: (id: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<unknown>;
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    createFunction: (
      cfg: { triggers?: Array<{ cron?: string; event?: string }> },
      handler: typeof capturedCronHandler
    ) => {
      // The cron is registered first (triggers[0].cron set); the on-demand
      // twin second (triggers[0].event set) — only capture the cron.
      if (cfg.triggers?.[0]?.cron) {
        capturedCronHandler = handler;
      }
      return { id: 'captured' };
    },
  },
}));

beforeEach(async () => {
  vi.resetModules();
  mockIsGscConfigured.mockReset();
  mockWithRlsBypass.mockReset();
  await import('../../apps/api/src/lib/inngest/functions/gsc-ingest.js');
});

describe('gscIngestCron dormancy guard', () => {
  it('isGscConfigured() false → logs + returns immediately, withRlsBypass (list-stores) is NEVER called', async () => {
    mockIsGscConfigured.mockReturnValue(false);

    const stepRunCalls: string[] = [];
    const step = {
      run: (id: string, fn: () => unknown) => {
        stepRunCalls.push(id);
        return Promise.resolve(fn());
      },
    };

    const result = await capturedCronHandler({ step });

    expect(result).toEqual({ configured: false, stores: 0, ingested: 0, skipped: 0, errored: 0 });
    expect(stepRunCalls).toEqual(['gsc-not-configured']);
    expect(mockWithRlsBypass).not.toHaveBeenCalled();
  });
});
