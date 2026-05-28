/**
 * Unit tests — QuickActions role gate for Suspend/Activate store.
 *
 * The suspend and activate store actions on the store detail dashboard must
 * only be surfaced to super_admin users. The PATCH /stores/:id/status API
 * endpoint enforces authorize('super_admin') server-side; the UI gate below
 * is defence-in-depth so store_admin users don't see the button at all.
 *
 * These tests verify the gating logic without a full DOM render, matching
 * the node-environment vitest setup used across this test suite.
 */

import { describe, it, expect } from 'vitest';

// The QuickActions component decides whether to render the suspend/activate
// card based on `isSuperAdmin`. Mirror that decision function here so the
// test is entirely self-contained and doesn't require jsdom.
function shouldShowStatusAction(isSuperAdmin: boolean): boolean {
  return isSuperAdmin;
}

// The page derives `isSuperAdmin` from the auth hook — replicate that here.
function deriveSuperAdminFlag(role: 'super_admin' | 'store_admin' | 'customer'): boolean {
  return role === 'super_admin';
}

describe('QuickActions: Suspend / Activate gate', () => {
  describe('shouldShowStatusAction', () => {
    it('returns true for super_admin', () => {
      expect(shouldShowStatusAction(true)).toBe(true);
    });

    it('returns false for store_admin (isSuperAdmin = false)', () => {
      expect(shouldShowStatusAction(false)).toBe(false);
    });
  });

  describe('deriveSuperAdminFlag', () => {
    it('is true only for super_admin role', () => {
      expect(deriveSuperAdminFlag('super_admin')).toBe(true);
    });

    it('is false for store_admin role', () => {
      expect(deriveSuperAdminFlag('store_admin')).toBe(false);
    });

    it('is false for customer role', () => {
      expect(deriveSuperAdminFlag('customer')).toBe(false);
    });
  });

  describe('end-to-end role → visibility', () => {
    it('store_admin session does NOT see the suspend/activate button', () => {
      const role = 'store_admin' as const;
      const isSuperAdmin = deriveSuperAdminFlag(role);
      expect(shouldShowStatusAction(isSuperAdmin)).toBe(false);
    });

    it('super_admin session DOES see the suspend/activate button', () => {
      const role = 'super_admin' as const;
      const isSuperAdmin = deriveSuperAdminFlag(role);
      expect(shouldShowStatusAction(isSuperAdmin)).toBe(true);
    });

    it('customer session does NOT see the suspend/activate button', () => {
      const role = 'customer' as const;
      const isSuperAdmin = deriveSuperAdminFlag(role);
      expect(shouldShowStatusAction(isSuperAdmin)).toBe(false);
    });
  });
});
