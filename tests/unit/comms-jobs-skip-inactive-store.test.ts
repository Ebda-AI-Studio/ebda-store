/**
 * Production 2026-11-10 15:53-15:57Z: `review-request` failed several times a minute with
 * `AppError: This store is no longer available` (410 STORE_STORAGE_REMOVED) for stores that are not active. A delayed
 * comms job must SKIP a store that is not active (inactive / suspended / deleted / storage removed), not fail and retry.
 * Same guard on the other comms jobs that wake up later for a store: campaign-send (scheduled), lifecycle-emails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@api/middleware/error-handler';

const h = vi.hoisted(() => ({
  lookupStore: vi.fn(),
  backendFor: vi.fn(),
  storeRepo: vi.fn(),
  storeDb: vi.fn(),
  isFeatureEnabled: vi.fn(async () => true),
  handlers: {} as Record<string, (ctx: unknown) => Promise<unknown>>,
  debug: vi.fn(),
}));

vi.mock('@api/lib/definer', () => ({ lookupStore: h.lookupStore }));
vi.mock('@api/lib/store-backend', () => ({ backendFor: h.backendFor }));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: h.storeRepo,
  storeDb: h.storeDb,
  storeWriter: vi.fn(),
  storeMoney: vi.fn(),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: h.isFeatureEnabled },
}));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/lifecycle-emails.service', () => ({
  getEnrollment: vi.fn(async () => ({ createdAt: new Date(0).toISOString(), trialEndsAt: null })),
  processLifecycleEmail: vi.fn(async () => {
    throw new AppError(410, 'STORE_STORAGE_REMOVED', 'This store is no longer available');
  }),
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  runInStoreScope: (_s: string, fn: () => unknown) => fn(),
  withStore: vi.fn(),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
  withoutHiddenStores: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: h.debug },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: (cfg: { id: string }, handler: (ctx: unknown) => Promise<unknown>) => {
      h.handlers[cfg.id] = handler;
      return { id: cfg.id };
    },
  },
}));

import { storeActiveForJob } from '@api/lib/jobs/store-db';
import '@api/lib/inngest/functions/review-request';
import '@api/lib/inngest/functions/lifecycle-emails';

const gone = () => new AppError(410, 'STORE_STORAGE_REMOVED', 'This store is no longer available');
const step = () => ({
  run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
  sleep: vi.fn(async () => {}),
  sleepUntil: vi.fn(async () => {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.storeRepo.mockRejectedValue(gone());
  h.storeDb.mockRejectedValue(gone());
  h.backendFor.mockResolvedValue('do');
});

describe('storeActiveForJob', () => {
  it('is false for a store that is not active (inactive / suspended / deleted / unknown), logged at debug', async () => {
    h.lookupStore.mockResolvedValue(null);
    await expect(storeActiveForJob('s1', 'review-request')).resolves.toBe(false);
    expect(h.lookupStore).toHaveBeenCalledWith({ id: 's1' }, ['active']);
    expect(h.debug).toHaveBeenCalledTimes(1);
  });

  it('is false for an active directory row whose storage is gone (410)', async () => {
    h.lookupStore.mockResolvedValue({ id: 's1', status: 'active' });
    h.backendFor.mockRejectedValue(gone());
    await expect(storeActiveForJob('s1', 'review-request')).resolves.toBe(false);
  });

  it('is true for an active store', async () => {
    h.lookupStore.mockResolvedValue({ id: 's1', status: 'active' });
    await expect(storeActiveForJob('s1', 'review-request')).resolves.toBe(true);
  });

  it('still throws when the directory is unreadable (503), so a transient outage retries', async () => {
    h.lookupStore.mockRejectedValue(new AppError(503, 'PLATFORM_DIRECTORY_UNAVAILABLE', 'x'));
    await expect(storeActiveForJob('s1', 'review-request')).rejects.toThrow('x');
  });
});

describe('review-request job', () => {
  const event = { name: 'order/delivered', data: { orderId: 'o1', storeId: 's1' } };

  it('skips, not fails, a store that is not active, before the 7-day wait', async () => {
    h.lookupStore.mockResolvedValue(null);
    const s = step();
    await expect(h.handlers['review-request']({ event, step: s })).resolves.toEqual({
      skipped: true,
      reason: 'store_not_active',
    });
    expect(s.sleep).not.toHaveBeenCalled();
  });

  it('skips a store that stopped being servable during the wait', async () => {
    h.lookupStore
      .mockResolvedValueOnce({ id: 's1', status: 'active' })
      .mockResolvedValueOnce({ id: 's1', status: 'active' });
    h.backendFor.mockResolvedValueOnce('do').mockRejectedValueOnce(gone());
    const s = step();
    await expect(h.handlers['review-request']({ event, step: s })).resolves.toEqual({
      skipped: true,
      reason: 'store_not_active',
    });
    expect(s.sleep).toHaveBeenCalledTimes(1);
    expect(h.storeDb).not.toHaveBeenCalled();
  });
});

describe('lifecycle-emails job', () => {
  it('stops, not fails, when the store is no longer active at a send time', async () => {
    h.lookupStore.mockResolvedValue(null);
    const r = await h.handlers['lifecycle-emails']({
      event: { name: 'store/self-serve-provisioned', data: { storeId: 's1' } },
      step: step(),
    });
    expect(r).toMatchObject({ reason: 'store_not_active' });
  });
});
