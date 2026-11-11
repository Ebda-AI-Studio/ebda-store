import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', () => ({ withStore: vi.fn(), prisma: {} }));

import { ordersOpenFor } from './plan-limit.service';

const now = new Date('2026-11-11T00:00:00Z');
const base = { trialEndsAt: null, billingMethod: 'instapay', hasSavedCard: false } as const;

describe('ordersOpenFor (S2-1/2, S3-B2)', () => {
  it('a canceled store takes no orders even with InstaPay chosen', () => {
    expect(ordersOpenFor({ ...base, status: 'canceled' }, now)).toBe(false);
  });
  it('past_due and active stay open; an ended trial with no payment method closes', () => {
    expect(ordersOpenFor({ ...base, status: 'past_due' }, now)).toBe(true);
    expect(ordersOpenFor({ ...base, status: 'active' }, now)).toBe(true);
    expect(
      ordersOpenFor(
        {
          status: 'trialing',
          trialEndsAt: new Date('2026-11-10'),
          billingMethod: null,
          hasSavedCard: false,
        } as never,
        now
      )
    ).toBe(false);
  });
});
