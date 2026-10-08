import { describe, expect, it } from 'vitest';
import { can } from './permissions';

describe('orders:refund', () => {
  it('is granted to store_admin and super_admin only, never to staff or customers', () => {
    expect(can({ role: 'store_admin' }, 'orders:refund')).toBe(true);
    expect(can({ role: 'super_admin' }, 'orders:refund')).toBe(true);
    expect(can({ role: 'staff' }, 'orders:refund')).toBe(false);
    expect(can({ role: 'customer' }, 'orders:refund')).toBe(false);
    expect(can(null, 'orders:refund')).toBe(false);
  });

  it('staff keep the rest of order management', () => {
    expect(can({ role: 'staff' }, 'orders:manage')).toBe(true);
  });

  it('an explicit permissions array wins (a staff member can be granted refunds)', () => {
    expect(
      can({ role: 'staff', permissions: ['orders:manage', 'orders:refund'] }, 'orders:refund')
    ).toBe(true);
  });
});
