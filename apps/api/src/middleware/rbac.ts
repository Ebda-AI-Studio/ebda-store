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

export type Role = 'customer' | 'admin' | 'super_admin';

const rolePermissions: Record<Role, Permission[]> = {
  customer: [
    'products:read',
    'orders:read',
    'ai:use',
  ],
  admin: [
    // All customer permissions
    'products:read',
    'orders:read',
    'ai:use',
    // Admin permissions
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

export function hasAnyPermission(role: Role, permissions: Permission[]): boolean {
  return permissions.some(p => hasPermission(role, p));
}

export function hasAllPermissions(role: Role, permissions: Permission[]): boolean {
  return permissions.every(p => hasPermission(role, p));
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
 * Require any of the specified permissions
 */
export function requireAnyPermission(permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const userRole = req.user.role as Role;

    if (!hasAnyPermission(userRole, permissions)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Missing required permissions: ${permissions.join(' or ')}`,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Require all of the specified permissions
 */
export function requireAllPermissions(permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const userRole = req.user.role as Role;

    if (!hasAllPermissions(userRole, permissions)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Missing required permissions: ${permissions.join(' and ')}`,
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

/**
 * Allow owner or admin access
 * Used for resources where the user can access their own data, or admins can access any data
 */
export function ownerOrAdmin(getOwnerId: (req: Request) => string | Promise<string>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const userRole = req.user.role as Role;

    // Admins have access to everything
    if (userRole === 'admin' || userRole === 'super_admin') {
      return next();
    }

    // Check if user is the owner
    try {
      const ownerId = await getOwnerId(req);
      if (ownerId === req.user.userId) {
        return next();
      }
    } catch {
      // If we can't determine the owner, deny access
    }

    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Access denied' },
    });
  };
}
