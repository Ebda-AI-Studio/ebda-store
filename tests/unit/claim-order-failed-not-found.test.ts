import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ count: 0, cur: null as { paymentStatus: string } | null }));
vi.mock('@ebda/database', () => ({
  prisma: {
    order: {
      updateMany: async () => ({ count: h.count }),
      findUnique: async () => h.cur,
    },
    $queryRaw: vi.fn(),
  },
}));

import { claimOrderFailed } from '@api/services/payment-state-claims';

describe('claimOrderFailed', () => {
  it('claims an unpaid order', async () => {
    h.count = 1;
    expect(await claimOrderFailed('o', 's')).toBe('claimed');
  });
  it('0 rows and no such order in this database is not_found, never "blocked_paid_or_settled" (a DO store order)', async () => {
    h.count = 0;
    h.cur = null;
    expect(await claimOrderFailed('o', 's')).toBe('not_found');
  });
  it('a paid order stays blocked and a failed one is already_failed', async () => {
    h.count = 0;
    h.cur = { paymentStatus: 'paid' };
    expect(await claimOrderFailed('o', 's')).toBe('blocked_paid_or_settled');
    h.cur = { paymentStatus: 'failed' };
    expect(await claimOrderFailed('o', 's')).toBe('already_failed');
  });
});
