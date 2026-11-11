import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStaffRoleConflict, STAFF_ROLE_CONFLICT_MESSAGE } from '../../lib/staff-role-conflict';

describe('staff invite ROLE_CONFLICT (S2-16)', () => {
  it('refuses customer and super_admin, lets staff and store_admin through', () => {
    expect(isStaffRoleConflict('customer')).toBe(true);
    expect(isStaffRoleConflict('super_admin')).toBe(true);
    expect(isStaffRoleConflict('staff')).toBe(false);
    expect(isStaffRoleConflict('store_admin')).toBe(false);
  });
  it('the message never names the account kind', () => {
    expect(STAFF_ROLE_CONFLICT_MESSAGE).not.toMatch(/platform|admin|customer/i);
  });
  it('staff.routes uses only the generic message for ROLE_CONFLICT', () => {
    const src = readFileSync(join(__dirname, '..', 'staff.routes.ts'), 'utf8');
    expect(src).not.toMatch(/belongs to a customer or platform admin/);
  });
});
