import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ owned: vi.fn(), sub: vi.fn() }));
vi.mock('@api/lib/definer', () => ({ ownedStoreIds: (...a: unknown[]) => h.owned(...a) }));
vi.mock('@ebda/database', () => ({
  withStore: (id: string, fn: (tx: unknown) => unknown) =>
    fn({ storeSubscription: { findUnique: () => h.sub(id) } }),
}));

import { liveBilledStoresOf } from '@api/services/account-closure-guard';

describe('liveBilledStoresOf', () => {
  it('counts active, past_due and trialing; ignores comped, canceled and no subscription', async () => {
    h.owned.mockResolvedValue(['a', 'b', 'c', 'd', 'e', 'f']);
    const by: Record<string, unknown> = {
      a: { status: 'active' },
      b: { status: 'past_due' },
      c: { status: 'trialing' },
      d: { status: 'comped' },
      e: { status: 'canceled' },
      f: null,
    };
    h.sub.mockImplementation(async (id: string) => by[id]);
    expect(await liveBilledStoresOf('u')).toEqual(['a', 'b', 'c']);
  });
});
