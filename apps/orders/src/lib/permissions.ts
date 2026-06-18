/**
 * Staff-role-aware permission derivation (client-side).
 *
 * The staff-role work is in flight on the API. Today the API's RBAC
 * (apps/api/src/middleware/rbac.ts) derives permissions from `role`:
 *   - store_admin / super_admin → have `orders:manage` (can change status)
 *   - customer → read-only
 *
 * This mirrors that exact table so the PWA shows only the actions a user is
 * actually permitted to perform — a viewer without `orders:manage` sees orders
 * read-only (status controls hidden). It is FORWARD-COMPATIBLE: if `/auth/me`
 * starts returning an explicit per-staff `permissions: string[]`, we honor that
 * array directly with zero further changes.
 */

export type Role = 'customer' | 'staff' | 'store_admin' | 'super_admin';

export type OrderPermission = 'orders:read' | 'orders:write' | 'orders:manage';

// Subset of apps/api/src/middleware/rbac.ts relevant to this app.
const ROLE_ORDER_PERMISSIONS: Record<Role, OrderPermission[]> = {
  customer: ['orders:read'],
  // staff: the PWA's primary audience — mirrors API rbac.ts staff entry exactly.
  staff: ['orders:read', 'orders:write', 'orders:manage'],
  store_admin: ['orders:read', 'orders:write', 'orders:manage'],
  super_admin: ['orders:read', 'orders:write', 'orders:manage'],
};

export interface PermissionSubject {
  role?: string;
  /** Forward-compat: explicit per-staff permission array if the API returns one. */
  permissions?: string[];
}

export function effectivePermissions(user: PermissionSubject | null): Set<string> {
  if (!user) return new Set();
  // Prefer an explicit array when present (future staff-role model).
  if (Array.isArray(user.permissions) && user.permissions.length > 0) {
    return new Set(user.permissions);
  }
  const role = (user.role as Role) ?? 'customer';
  return new Set(ROLE_ORDER_PERMISSIONS[role] ?? ROLE_ORDER_PERMISSIONS.customer);
}

export function can(user: PermissionSubject | null, permission: OrderPermission): boolean {
  return effectivePermissions(user).has(permission);
}
