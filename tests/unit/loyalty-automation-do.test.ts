/**
 * Ruling NZ-PG-7: the loyalty daily automation on a store served by its Durable Object. Point expiry and the birthday bonus go
 * to the store's DO (`loyaltyExpire` / `loyaltyBirthdays`); `prisma` throws on any use, a failing store never stops the sweep.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stores: [{ id: 'a' }, { id: 'b' }, { id: 'pg' }] as Array<{ id: string }>,
  expireCalls: [] as Array<{ id: string; after: string | null }>,
  birthdayCalls: [] as Array<{ id: string; month: number; day: number }>,
  failStore: null as string | null,
  pages: 2,
}));
vi.mock('@ebda/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, p) => {
        throw new Error(`Postgres touched: prisma.${String(p)}`);
      },
    }
  ),
  runInStoreScope: async (_id: string, fn: () => unknown) => fn(),
  storeDirectory: async () => h.stores,
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/lib/leader-election', () => ({
  withLeaderLock: async (_n: string, _t: number, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeMoney: async (id: string) => {
    if (id === 'pg') return null;
    return {
      loyaltyExpire: async (a: { after?: string | null }) => {
        if (h.failStore === id) throw new Error('DO unreachable');
        h.expireCalls.push({ id, after: a.after ?? null });
        const n = h.expireCalls.filter(c => c.id === id).length;
        return { members: 1, expired: 5, last: `row${n}`, more: n < h.pages };
      },
      loyaltyBirthdays: async (a: { month: number; day: number }) => {
        h.birthdayCalls.push({ id, month: a.month, day: a.day });
        return { awarded: 0, points: 0 };
      },
    };
  },
}));

import { loyaltyAutomationService } from '@api/services/loyalty-automation.service';

beforeEach(() => {
  h.expireCalls = [];
  h.birthdayCalls = [];
  h.failStore = null;
  h.stores = [{ id: 'a' }, { id: 'b' }];
});

describe('loyalty automation on DO stores', () => {
  it('expires points through the DO, page by page with the cursor, and never touches Postgres', async () => {
    await loyaltyAutomationService.processPointExpiration();
    expect(h.expireCalls).toEqual([
      { id: 'a', after: null },
      { id: 'a', after: 'row1' },
      { id: 'b', after: null },
      { id: 'b', after: 'row1' },
    ]);
  });

  it('one store failing does not stop the sweep over the others', async () => {
    h.failStore = 'a';
    await loyaltyAutomationService.processPointExpiration();
    expect(h.expireCalls.every(c => c.id === 'b')).toBe(true);
    expect(h.expireCalls.length).toBeGreaterThan(0);
  });

  it("awards birthdays through the DO with today's month and day", async () => {
    await loyaltyAutomationService.processBirthdayBonuses();
    expect(h.birthdayCalls.map(c => c.id)).toEqual(['a', 'b']);
    const now = new Date();
    expect(h.birthdayCalls[0]).toMatchObject({ month: now.getMonth() + 1, day: now.getDate() });
  });
});
