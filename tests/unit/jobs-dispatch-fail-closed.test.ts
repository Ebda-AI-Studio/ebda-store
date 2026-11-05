/**
 * Ruling JOBS-ORPHAN-1 (defect 2): inside the Worker an event that would start nothing must THROW, so the
 * caller's mark-the-row-failed path runs. Without bindings (Node: tests, scripts, local dev) it stays a no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStart } = vi.hoisted(() => ({ mockStart: vi.fn() }));
vi.mock('@api/lib/jobs/start', () => ({ startJob: mockStart }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { dispatchEvents } from '@api/lib/jobs/dispatch';
import { clearCfBindings, setCfBindings, type CfBindings } from '@api/cf/bindings';
import { clearJobRegistry, registerJob } from '@api/lib/jobs/registry';

const EVENT = 'bulk-ai/recommendations-requested';
const bound = { JOBS_WORKFLOW: {}, JOBS_QUEUE: {} } as unknown as CfBindings;

beforeEach(() => {
  vi.clearAllMocks();
  clearCfBindings();
  clearJobRegistry();
  mockStart.mockResolvedValue('started');
});

describe('dispatchEvents fails closed in the Worker', () => {
  it('Node (no bindings): a no-op, nothing thrown, nothing started', async () => {
    registerJob({ id: 'bulk-ai-recommendations', triggers: [{ event: EVENT }] } as never, vi.fn());
    await expect(dispatchEvents({ name: EVENT, data: {} })).resolves.toEqual({ ids: [] });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('Worker: an event nobody subscribes to throws', async () => {
    setCfBindings(bound);
    await expect(dispatchEvents({ name: 'nobody/listens', data: {} })).rejects.toThrow(
      /nobody\/listens.*no job subscribes/
    );
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('Worker: a subscribed event with no runner bound (no JOBS_WORKFLOW / JOBS_QUEUE) throws', async () => {
    registerJob({ id: 'bulk-ai-recommendations', triggers: [{ event: EVENT }] } as never, vi.fn());
    setCfBindings({} as CfBindings);
    await expect(dispatchEvents({ name: EVENT, data: {} })).rejects.toThrow(/no runner is bound/);
  });

  it('Worker: a subscribed, bound event starts the job', async () => {
    registerJob({ id: 'bulk-ai-recommendations', triggers: [{ event: EVENT }] } as never, vi.fn());
    setCfBindings(bound);
    await expect(dispatchEvents({ name: EVENT, data: {} })).resolves.toEqual({ ids: [] });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});
