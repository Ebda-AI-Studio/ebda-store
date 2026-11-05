/** Opus I1 (Ruling CF-OPUS-1): the DO erasure scope is finalized by the propagation job, only after every step succeeded. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { finalizeErasure, deleteOneSignalPlayers, deletePostHogPerson } = vi.hoisted(() => ({
  finalizeErasure: vi.fn(async () => undefined),
  deleteOneSignalPlayers: vi.fn(async () => undefined),
  deletePostHogPerson: vi.fn(async () => undefined),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: vi.fn(async (id: string) => ({
    money: id === 'do-store' ? { finalizeErasure } : null,
  })),
}));
vi.mock('@api/services/privacy-propagation.service', () => ({
  deleteOneSignalPlayers,
  deletePostHogPerson,
  summarizePropagationFailures: () => 'x',
}));

import { accountErasedPropagation } from '@api/lib/inngest/functions/account-erased-propagation';
import { jobDataClass } from '@api/lib/jobs/job-data';
import { getJob } from '@api/lib/jobs/registry';

const step = { run: (_id: string, fn: () => unknown) => Promise.resolve(fn()) } as never;
const run = (data: Record<string, unknown>) =>
  (
    getJob('account-erased-propagation') as unknown as { handler: (c: unknown) => Promise<unknown> }
  ).handler({
    event: { name: 'account/erased', data },
    step,
  });

describe('account-erased-propagation finalizes the DO scope', () => {
  beforeEach(() => vi.clearAllMocks());
  it('is runnable for DO stores (platform-only) and registered', () => {
    expect(accountErasedPropagation.id).toBe('account-erased-propagation');
    expect(jobDataClass('account-erased-propagation')).toBe('none');
    expect(jobDataClass('ci-erasure-second-pass')).toBe('none');
  });
  it('finalizes after success', async () => {
    await run({ userId: 'u1', storeId: 'do-store' });
    expect(finalizeErasure).toHaveBeenCalledWith({ userId: 'u1' });
  });
  it('does NOT finalize when a propagation step fails (the scope must survive the retry)', async () => {
    deletePostHogPerson.mockRejectedValueOnce(new Error('posthog down'));
    await expect(run({ userId: 'u1', storeId: 'do-store' })).rejects.toThrow();
    expect(finalizeErasure).not.toHaveBeenCalled();
  });
  it('is a no-op for a Postgres store', async () => {
    await run({ userId: 'u1', storeId: 'pg-store' });
    expect(finalizeErasure).not.toHaveBeenCalled();
  });
});
