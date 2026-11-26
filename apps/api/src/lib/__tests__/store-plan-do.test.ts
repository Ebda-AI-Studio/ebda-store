import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeRepo = vi.fn();
const platformDb = vi.fn();
vi.mock('../repo-factory', () => ({
  storeRepo: (id: string) => storeRepo(id),
  requestPlanMemo: (_id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../platform-db', () => ({ platformDb: () => platformDb() }));

import { readStorePlan } from '../store-plan';

const client = (plan: string | null) => ({
  store: { findUnique: vi.fn().mockResolvedValue(plan ? { plan } : null) },
});

describe('readStorePlan: the one entitlement plan reader', () => {
  beforeEach(() => {
    storeRepo.mockReset();
    platformDb.mockReset();
  });

  it('DO store: D1 wins over a stale DO mirror (Business store was shown the old tier)', async () => {
    const stale = client('starter');
    storeRepo.mockResolvedValue({ backend: 'do', db: stale });
    platformDb.mockResolvedValue(client('enterprise'));
    expect(await readStorePlan({} as never, 's1')).toEqual({ plan: 'enterprise' });
    expect(stale.store.findUnique).not.toHaveBeenCalled();
  });

  it('DO store: a DOWNGRADE in D1 is seen even though the mirror still says Business (no fail-open)', async () => {
    storeRepo.mockResolvedValue({ backend: 'do', db: client('enterprise') });
    platformDb.mockResolvedValue(client('starter'));
    expect(await readStorePlan({} as never, 's1')).toEqual({ plan: 'starter' });
  });

  it('DO store falls back to the DO row when D1 is unbound or has no row', async () => {
    storeRepo.mockResolvedValue({ backend: 'do', db: client('professional') });
    platformDb.mockResolvedValue(undefined);
    expect(await readStorePlan({} as never, 's1')).toEqual({ plan: 'professional' });
    platformDb.mockResolvedValue(client(null));
    expect(await readStorePlan({} as never, 's1')).toEqual({ plan: 'professional' });
  });

  it('a pg store reads its own client and never touches D1', async () => {
    storeRepo.mockResolvedValue({ backend: 'pg', db: {} });
    expect(await readStorePlan(client('starter') as never, 's1')).toEqual({ plan: 'starter' });
    expect(platformDb).not.toHaveBeenCalled();
  });
});
