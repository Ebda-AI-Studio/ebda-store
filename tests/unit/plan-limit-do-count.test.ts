/**
 * Ruling CF-CAP-1: the plan caps on products and orders count a DO store's rows on its Durable Object (the Postgres copy is sealed
 * and stale, so counting it would leave the store under its cap for ever); a Postgres store counts exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  backend: 'do' as 'do' | 'pg',
  doProducts: 7,
  doOrders: 3,
  pgCalls: [] as string[],
}));
vi.mock('@ebda/database', async () => {
  const mock = await import('./helpers/database-mock');
  return mock.databaseMock({
    prisma: {},
    extra: {
      withStore: async (_id: string, fn: (tx: any) => unknown) =>
        fn({
          product: { count: async () => (h.pgCalls.push('product'), 100) },
          order: { count: async () => (h.pgCalls.push('order'), 200) },
          storeStaff: { count: async () => (h.pgCalls.push('staff'), 2) },
        }),
    },
  });
});
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () =>
    h.backend === 'do'
      ? {
          backend: 'do',
          db: {
            product: { count: async () => h.doProducts },
            order: { count: async () => h.doOrders },
          },
        }
      : { backend: 'pg', db: {} },
}));

import { countUsage } from '@api/services/plan-limit.service';

beforeEach(() => {
  h.backend = 'do';
  h.pgCalls.length = 0;
});

describe('countUsage on a DO store (Ruling CF-CAP-1)', () => {
  it('counts products and this month’s orders on the DO, never on Postgres', async () => {
    expect(await countUsage('s1', 'maxProducts')).toBe(7);
    expect(await countUsage('s1', 'maxOrdersPerMonth')).toBe(3);
    expect(h.pgCalls).toEqual([]);
  });

  it('staff are platform rows: still counted on Postgres', async () => {
    expect(await countUsage('s1', 'maxStaff')).toBe(2);
    expect(h.pgCalls).toEqual(['staff']);
  });

  it('a Postgres store counts exactly as before', async () => {
    h.backend = 'pg';
    expect(await countUsage('s1', 'maxProducts')).toBe(100);
    expect(await countUsage('s1', 'maxOrdersPerMonth')).toBe(200);
  });
});
