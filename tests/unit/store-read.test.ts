import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  backend: 'do' as 'do' | 'pg',
  withStore: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) => fn('PG_TX')),
}));
vi.mock('@ebda/database', () => ({ withStore: h.withStore }));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({ backend: h.backend, db: 'DO_DB' }),
}));

import { withStoreRead } from '@api/lib/store-read';

beforeEach(() => {
  h.withStore.mockClear();
});

describe('withStoreRead', () => {
  it('a DO store reads on its DO client and opens no Postgres scope', async () => {
    h.backend = 'do';
    expect(await withStoreRead('s', async tx => tx)).toBe('DO_DB');
    expect(h.withStore).not.toHaveBeenCalled();
  });
  it('a Postgres store keeps withStore', async () => {
    h.backend = 'pg';
    expect(await withStoreRead('s', async tx => tx)).toBe('PG_TX');
    expect(h.withStore).toHaveBeenCalledTimes(1);
  });
});
