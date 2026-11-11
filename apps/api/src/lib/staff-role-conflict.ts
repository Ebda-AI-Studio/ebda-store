/** Generic on purpose (S2-16): never says WHICH kind of account the email is. */
export const STAFF_ROLE_CONFLICT_MESSAGE = 'This email cannot be used for store staff.';

/** A customer or platform-admin account can never be staff; the identity's REAL role decides. */
export function isStaffRoleConflict(role: string): boolean {
  return role === 'customer' || role === 'super_admin';
}
