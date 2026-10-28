import { Request, Response, NextFunction } from 'express';

// ==========================================
// Permission Definitions
// ==========================================

export type Permission =
  // User permissions
  | 'users:read'
  | 'users:write'
  | 'users:delete'
  | 'users:manage'
  // Product permissions
  | 'products:read'
  | 'products:write'
  | 'products:delete'
  // Order permissions
  | 'orders:read'
  | 'orders:write'
  | 'orders:manage'
  | 'orders:refund'
  // Bulk export of customers' personal data (SEC-14): owners only, never staff
  | 'customers:export'
  // Store permissions
  | 'store:read'
  | 'store:write'
  | 'store:settings'
  // Analytics permissions
  | 'analytics:read'
  // Payment permissions
  | 'payments:read'
  | 'payments:refund'
  // Audit permissions
  | 'audit:read'
  // AI permissions
  | 'ai:use'
  | 'ai:manage'
  // Returns permissions
  | 'returns:read'
  | 'returns:write'
  // System settings permissions (super admin)
  | 'settings:read'
  | 'settings:write'
  | 'settings:delete';

// ==========================================
// Role Definitions
// ==========================================

export type Role = 'customer' | 'store_admin' | 'super_admin' | 'staff';

const rolePermissions: Record<Role, Permission[]> = {
  customer: ['products:read', 'orders:read', 'ai:use'],
  /**
   * staff — store-scoped team member.
   *
   * Permitted: day-to-day operations (orders, products, inventory, customers,
   * analytics, returns).  They can read/write orders and products but CANNOT
   * touch billing, store settings, payment configuration, or audit logs.
   * Uses `ai:use` (front-end AI helpers) but not `ai:manage` (bulk sweeps /
   * training controls that only the owner should trigger).
   */
  staff: [
    'products:read',
    'products:write',
    'orders:read',
    'orders:write',
    'orders:manage',
    'store:read',
    'analytics:read',
    'returns:read',
    'returns:write',
    'ai:use',
  ],
  store_admin: [
    // All customer permissions
    'products:read',
    'orders:read',
    'ai:use',
    // Store admin permissions (same as admin)
    'users:read',
    'users:write',
    'products:write',
    'products:delete',
    'orders:write',
    'orders:manage',
    'orders:refund',
    'store:read',
    'store:write',
    'store:settings',
    'analytics:read',
    'payments:read',
    'payments:refund',
    'audit:read',
    'customers:export',
    'ai:manage',
    'returns:read',
    'returns:write',
  ],
  super_admin: [
    // All permissions
    'users:read',
    'users:write',
    'users:delete',
    'users:manage',
    'products:read',
    'products:write',
    'products:delete',
    'orders:read',
    'orders:write',
    'orders:manage',
    'orders:refund',
    'store:read',
    'store:write',
    'store:settings',
    'analytics:read',
    'payments:read',
    'payments:refund',
    'audit:read',
    'customers:export',
    'ai:use',
    'ai:manage',
    'returns:read',
    'returns:write',
    // System settings (super admin only)
    'settings:read',
    'settings:write',
    'settings:delete',
  ],
};

// ==========================================
// Permission Checking
// ==========================================

export function hasPermission(role: Role, permission: Permission): boolean {
  const permissions = rolePermissions[role];
  return permissions?.includes(permission) || false;
}

// ==========================================
// Middleware
// ==========================================

/**
 * Require a specific permission
 */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const userRole = req.user.role as Role;

    if (!hasPermission(userRole, permission)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Missing required permission: ${permission}`,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Require a specific role
 */
export function requireRole(roles: Role | Role[]) {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const userRole = req.user.role as Role;

    if (!allowedRoles.includes(userRole)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Required role: ${allowedRoles.join(' or ')}`,
        },
      });
      return;
    }

    next();
  };
}
