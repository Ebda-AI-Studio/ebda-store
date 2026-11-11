import { describe, expect, it } from 'vitest';
import { isStoreScopedRole } from './store-scoped-role';

describe('isStoreScopedRole (S2-9)', () => {
  it('sends owners and staff to their store, never the platform dashboard', () => {
    expect(isStoreScopedRole('store_admin')).toBe(true);
    expect(isStoreScopedRole('staff')).toBe(true);
  });
  it('keeps super_admin and unknown roles on the platform dashboard', () => {
    expect(isStoreScopedRole('super_admin')).toBe(false);
    expect(isStoreScopedRole('customer')).toBe(false);
    expect(isStoreScopedRole(undefined)).toBe(false);
  });
});
