import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: 0,
  row: { isDemo: true } as { isDemo: boolean } | null,
  boom: false,
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({
    backend: 'do',
    db: {
      store: {
        findUnique: async () => {
          h.calls++;
          if (h.boom) throw new Error('do down');
          return h.row;
        },
      },
    },
  }),
}));
vi.mock('@ebda/database', () => ({ withStore: async () => null }));

import { clearDemoStoreCache, isDemoStore } from '@api/lib/demo-store';

beforeEach(() => {
  clearDemoStoreCache();
  h.calls = 0;
  h.row = { isDemo: true };
  h.boom = false;
});

describe('isDemoStore', () => {
  it('reads isDemo and caches it', async () => {
    expect(await isDemoStore('a')).toBe(true);
    expect(await isDemoStore('a')).toBe(true);
    expect(h.calls).toBe(1);
  });
  it('a real store is not a demo; an unknown store is not a demo', async () => {
    h.row = { isDemo: false };
    expect(await isDemoStore('b')).toBe(false);
    h.row = null;
    expect(await isDemoStore('c')).toBe(false);
  });
  it('fails OPEN on a read error (a real merchant never loses a notice)', async () => {
    h.boom = true;
    expect(await isDemoStore('d')).toBe(false);
  });
});
