/**
 * Issue 2119 — a fully ungrounded answer-engine scan used to be a green run:
 * the Gemini adapter warned once per PROCESS (so a recurrence in a later week
 * logged nothing) and the cron's completion log counted every ungrounded check
 * as healthy. Now the throttle resets per store scan and the cron raises a P1
 * alert when any check in the run was ungrounded.
 *
 * Mutation proof: delete the `if (ungroundedChecks > 0)` alert block in
 * answer-engine-citation-scan.ts → the first case goes red; delete the
 * `resetGeminiGroundingWarnOnce()` call → the second goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  runCitationScan: vi.fn(),
  sendAlert: vi.fn(async () => 'sent'),
  reset: vi.fn(),
  createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })),
}));

vi.mock('@force/database', () => ({
  runInTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  withRlsBypass: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ store: { findMany: async () => [{ id: 's1' }, { id: 's2' }] } }),
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { createFunction: h.createFunction } }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn(async () => true) },
}));
vi.mock('@api/services/answer-engine/citation-scan.service', () => ({
  runCitationScan: h.runCitationScan,
}));
vi.mock('@api/services/answer-engine/gemini.provider', () => ({
  resetGeminiGroundingWarnOnce: h.reset,
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@api/lib/ai-plan-eligibility', () => ({
  aiEligiblePlanFilter: {},
  isAiEligiblePlan: () => true,
}));

import {
  answerEngineCitationScanCron,
  scanStoreCitations,
} from '@api/lib/inngest/functions/answer-engine-citation-scan';

const step = { run: async (_id: string, fn: () => unknown) => fn() };
const cronHandler = (
  answerEngineCitationScanCron as unknown as {
    handler: (ctx: { step: typeof step }) => Promise<Record<string, number>>;
  }
).handler;

beforeEach(() => vi.clearAllMocks());

describe('answer-engine citation scan — ungrounded run is not silent', () => {
  it('alerts when any check in the run fell back to an ungrounded answer', async () => {
    h.runCitationScan
      .mockResolvedValueOnce([{ engine: 'gemini', checks: 8, ungrounded: 8 }])
      .mockResolvedValueOnce([{ engine: 'gemini', checks: 8 }]);

    const out = await cronHandler({ step });

    expect(out).toMatchObject({ totalChecks: 16, ungroundedChecks: 8 });
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    expect(h.sendAlert.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      source: 'cron.answer-engine-citation-scan',
    });
  });

  it('a fully grounded run does not alert', async () => {
    h.runCitationScan.mockResolvedValue([{ engine: 'gemini', checks: 8 }]);
    await cronHandler({ step });
    expect(h.sendAlert).not.toHaveBeenCalled();
  });

  it('resets the Gemini warn-once throttle at every store scan', async () => {
    h.runCitationScan.mockResolvedValue([{ engine: 'gemini', checks: 1 }]);
    await scanStoreCitations('s1');
    await scanStoreCitations('s2');
    expect(h.reset).toHaveBeenCalledTimes(2);
  });
});
