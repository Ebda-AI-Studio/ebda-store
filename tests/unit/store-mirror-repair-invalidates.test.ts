/**
 * Ruling B1-PLAN-SOT-1: the plan tier is a NEVER-stale entitlement. When the hourly reconciler re-pushes a stale DO plan
 * (or billing suspension) copy, the cached feature map and the public store payloads are dropped at once; a profile-only
 * repair (template / name) does not touch them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  copy: vi.fn(async () => undefined),
  invalidate: vi.fn(async () => undefined),
  bust: vi.fn(async () => undefined),
}));
vi.mock('@api/lib/repo-factory', () => ({ copyStoreSettings: h.copy, storeDb: vi.fn() }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { invalidateCache: h.invalidate },
}));
vi.mock('@api/services/store.service', () => ({ bustStoreCachesById: h.bust }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/lib/store-directory-sync', () => ({ syncStoreDirectoryFromPg: vi.fn() }));
vi.mock('@api/lib/store-backend', () => ({ hasStoresOnBackend: vi.fn() }));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => ({}) }));
vi.mock('@ebda/database', () => ({ storeDirectory: vi.fn(), withStore: vi.fn() }));

import { repairDoMirror } from '../../apps/api/src/lib/store-directory-reconcile';

beforeEach(() => vi.clearAllMocks());

describe('repairDoMirror', () => {
  it('a repaired plan copy drops the feature cache, then the public store caches', async () => {
    await repairDoMirror('s1', { plan: 'enterprise' });
    expect(h.copy).toHaveBeenCalledWith('s1', { plan: 'enterprise' });
    expect(h.invalidate).toHaveBeenCalledWith('s1');
    expect(h.bust).toHaveBeenCalledWith('s1');
    expect(h.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      h.bust.mock.invocationCallOrder[0]
    );
  });
  it('a repaired billing suspension does too', async () => {
    await repairDoMirror('s1', { billingSuspendedReason: 'unpaid' });
    expect(h.invalidate).toHaveBeenCalledWith('s1');
  });
  it('a profile-only repair leaves the caches alone', async () => {
    await repairDoMirror('s1', { template: 'qamar' });
    expect(h.copy).toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.bust).not.toHaveBeenCalled();
  });
  it('an invalidation that fails once is retried; failing twice throws so the reconciler raises it', async () => {
    h.invalidate.mockRejectedValueOnce(new Error('kv down'));
    await repairDoMirror('s1', { plan: 'enterprise' });
    expect(h.invalidate).toHaveBeenCalledTimes(2);
    expect(h.bust).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    h.invalidate
      .mockRejectedValueOnce(new Error('kv down'))
      .mockRejectedValueOnce(new Error('kv down'));
    await expect(repairDoMirror('s1', { plan: 'enterprise' })).rejects.toThrow(
      /entitlement caches could not be cleared \(2 tries\): kv down/
    );
    expect(h.copy).toHaveBeenCalledTimes(1);
  });
});
