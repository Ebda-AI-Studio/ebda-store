import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeRepo = vi.fn();
const platformDb = vi.fn();
vi.mock('../repo-factory', () => ({ storeRepo: (id: string) => storeRepo(id) }));
vi.mock('../platform-db', () => ({ platformDb: () => platformDb() }));

import { readStorePlan } from '../store-plan';

const doDb = (plan: string) => ({ store: { findUnique: vi.fn().mockResolvedValue({ plan }) } });

describe('readStorePlan on a Durable Object store', () => {
  beforeEach(() => {
    storeRepo.mockReset();
    platformDb.mockReset();
  });

  it('reads the authoritative D1 plan, not a stale DO mirror (Business store showed Business features locked)', async () => {
    const stale = doDb('starter');
    storeRepo.mockResolvedValue({ backend: 'do', db: stale });
    platformDb.mockResolvedValue({
      store: { findUnique: vi.fn().mockResolvedValue({ plan: 'enterprise' }) },
    });
    const r = await readStorePlan({} as never, 's1');
    expect(r).toEqual({ plan: 'enterprise' });
    expect(stale.store.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to the DO row when the platform D1 is not bound', async () => {
    storeRepo.mockResolvedValue({ backend: 'do', db: doDb('professional') });
    platformDb.mockResolvedValue(undefined);
    expect(await readStorePlan({} as never, 's1')).toEqual({ plan: 'professional' });
  });

  it('a pg store still reads its own client', async () => {
    storeRepo.mockResolvedValue({ backend: 'pg', db: {} });
    const pg = doDb('starter');
    expect(await readStorePlan(pg as never, 's1')).toEqual({ plan: 'starter' });
    expect(platformDb).not.toHaveBeenCalled();
  });
});
