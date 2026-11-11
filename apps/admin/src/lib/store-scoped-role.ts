/**
 * S2-9: a merchant owner (`store_admin`) AND their staff (`staff`) belong to one store, so the
 * platform-wide super-admin dashboard at `/` is never theirs. Only `super_admin` stays there.
 */
export function isStoreScopedRole(role: string | undefined | null): boolean {
  return role === 'store_admin' || role === 'staff';
}
