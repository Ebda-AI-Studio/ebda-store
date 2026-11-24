/**
 * C2 of the #772 re-review: when the execute job dies for good the request must not stay `executing` (nothing reads it again and
 * a cancel is refused). The job's onFailure recovers it and raises a P1 alert.
 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  alert: vi.fn(async () => undefined),
  recover: vi.fn(async () => ({
    recovered: true,
    retryScheduled: true,
    exhausted: false,
    attempt: 1,
  })),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.alert }));
vi.mock('@api/services/store-deletion.wiring', () => ({ productionDeletionDeps: () => ({}) }));
vi.mock('@api/services/store-deletion.service', () => ({
  executeStoreDeletion: vi.fn(),
  recoverFailedExecution: h.recover,
  MAX_EXECUTION_RECOVERIES: 5,
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (opts: unknown, fn: unknown) => ({ opts, fn }) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('store-deletion-execute onFailure', () => {
  it('is registered on the function and calls the recovery with the original event ids', async () => {
    const mod = await import('@api/lib/inngest/functions/store-deletion-execute');
    const { opts } = mod.storeDeletionExecute as unknown as {
      opts: { onFailure: (a: unknown) => Promise<void> };
    };
    expect(typeof opts.onFailure).toBe('function');
    await opts.onFailure({
      event: { data: { event: { data: { storeId: 's1', requestId: 'r1' } } } },
      error: { message: 'delete exploded' },
    });
    expect(h.recover).toHaveBeenCalledWith(
      { storeId: 's1', requestId: 'r1', reason: 'delete exploded' },
      expect.anything()
    );
  });

  it('raises a P1 alert whether or not the request could be recovered', async () => {
    const { handleStoreDeletionFailure } =
      await import('@api/lib/inngest/functions/store-deletion-execute');
    h.alert.mockClear();
    h.recover.mockResolvedValueOnce({
      recovered: true,
      retryScheduled: true,
      exhausted: false,
      attempt: 2,
    });
    expect(
      (await handleStoreDeletionFailure({ storeId: 's1', requestId: 'r1' }, 'boom')).recovered
    ).toBe(true);
    h.recover.mockRejectedValueOnce(new Error('db down'));
    expect(
      (await handleStoreDeletionFailure({ storeId: 's1', requestId: 'r1' }, 'boom')).recovered
    ).toBe(false);
    expect(h.alert).toHaveBeenCalledTimes(2);
    expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p1' }));
    expect(h.alert.mock.calls[1][0]).toMatchObject({
      body: expect.stringContaining('NOT recovered'),
    });
  });

  it('names the retry in the alert, and says NEEDS MANUAL ACTION once the retries are spent', async () => {
    const { handleStoreDeletionFailure } =
      await import('@api/lib/inngest/functions/store-deletion-execute');
    h.alert.mockClear();
    h.recover.mockResolvedValueOnce({
      recovered: true,
      retryScheduled: true,
      exhausted: false,
      attempt: 2,
    });
    await handleStoreDeletionFailure({ storeId: 's1', requestId: 'r1' }, 'boom');
    expect(h.alert.mock.calls[0][0].body).toContain('retry queued for tomorrow (attempt 2/5)');
    h.recover.mockResolvedValueOnce({
      recovered: true,
      retryScheduled: false,
      exhausted: true,
      attempt: 6,
    });
    await handleStoreDeletionFailure({ storeId: 's1', requestId: 'r1' }, 'boom');
    expect(h.alert.mock.calls[1][0].body).toContain('NEEDS MANUAL ACTION');
  });

  it('ignores an event without ids', async () => {
    const { handleStoreDeletionFailure } =
      await import('@api/lib/inngest/functions/store-deletion-execute');
    expect(await handleStoreDeletionFailure({}, 'x')).toMatchObject({ recovered: false });
  });
});
