import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeRepo = vi.fn();
const platformDb = vi.fn();
vi.mock('../repo-factory', () => ({ storeRepo: (id: string) => storeRepo(id) }));
vi.mock('../platform-db', () => ({ platformDb: () => platformDb() }));

import { reconcileDoPlan } from '../store-plan';

const d1 = (plan: string | null) => ({
  store: { findUnique: vi.fn().mockResolvedValue(plan ? { plan } : null) },
});

describe('reconcileDoPlan (stale DO plan mirror self-heal)', () => {
  beforeEach(() => {
    storeRepo.mockReset();
    platformDb.mockReset();
  });

  it('D1 says enterprise, the DO mirror still says starter: D1 wins and the mirror is re-synced', async () => {
    storeRepo.mockResolvedValue({ backend: 'do' });
    platformDb.mockResolvedValue(d1('enterprise'));
    const onStale = vi.fn();
    expect(await reconcileDoPlan('s1', 'starter', onStale)).toBe('enterprise');
    expect(onStale).toHaveBeenCalledWith('s1');
  });

  it('an in-sync mirror triggers no re-sync', async () => {
    storeRepo.mockResolvedValue({ backend: 'do' });
    platformDb.mockResolvedValue(d1('enterprise'));
    const onStale = vi.fn();
    expect(await reconcileDoPlan('s1', 'enterprise', onStale)).toBe('enterprise');
    expect(onStale).not.toHaveBeenCalled();
  });

  it('a pg store, an unbound D1 or a missing D1 row keep the given plan and read nothing', async () => {
    const onStale = vi.fn();
    storeRepo.mockResolvedValue({ backend: 'pg' });
    expect(await reconcileDoPlan('s1', 'starter', onStale)).toBe('starter');
    expect(platformDb).not.toHaveBeenCalled();
    storeRepo.mockResolvedValue({ backend: 'do' });
    platformDb.mockResolvedValue(undefined);
    expect(await reconcileDoPlan('s1', 'starter', onStale)).toBe('starter');
    platformDb.mockResolvedValue(d1(null));
    expect(await reconcileDoPlan('s1', 'starter', onStale)).toBe('starter');
    expect(onStale).not.toHaveBeenCalled();
  });
});
