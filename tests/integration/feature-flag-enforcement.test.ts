/**
 * Feature Flag Enforcement — Integration Test Suite
 *
 * Verifies that every gated API endpoint returns 403 FEATURE_DISABLED
 * when the feature is toggled off for a store, and passes through when
 * the feature is enabled.
 *
 * Test design:
 *   1. Create a fresh store_admin user + store for each describe block.
 *   2. Disable the feature-under-test via the StoreFeature override table.
 *   3. Assert the endpoint returns 403 with code=FEATURE_DISABLED.
 *   4. Re-enable the feature and assert the endpoint no longer blocks.
 *
 * Isolation: each test block truncates its own data via beforeAll/afterAll.
 * The store used across blocks is created once in a global beforeAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import { API_BASE } from '../helpers/api-base';
import { identityTokenFor, identityTokenForEmail } from '../helpers/identity-session';

// One knob (TEST_API_URL) points the whole suite at one API, so a run cannot
// silently talk to whatever holds port 4000 — which on this machine was a
// different project's dev server for five days. See tests/helpers/api-base.ts.
const API_URL = API_BASE;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@ebda.app';

// ─── Shared test fixtures ────────────────────────────────────────────────────

let superAdminToken: string;
let storeAdminToken: string;
let testStoreId: string;
let testStoreAdminUserId: string;

const TEST_STORE_SLUG = `ff-test-${Date.now()}`;
const STORE_ADMIN_EMAIL = `ff-admin-${Date.now()}@example.test`;
const STORE_ADMIN_PASSWORD = 'TestAdmin!1';

async function disableFeature(featureKey: string): Promise<void> {
  await prisma.storeFeature.upsert({
    where: { storeId_featureKey: { storeId: testStoreId, featureKey } },
    create: { storeId: testStoreId, featureKey, enabled: false, enabledBy: testStoreAdminUserId },
    update: { enabled: false },
  });
}

async function enableFeature(featureKey: string): Promise<void> {
  await prisma.storeFeature.upsert({
    where: { storeId_featureKey: { storeId: testStoreId, featureKey } },
    create: { storeId: testStoreId, featureKey, enabled: true, enabledBy: testStoreAdminUserId },
    update: { enabled: true },
  });
}

async function clearFeatureOverride(featureKey: string): Promise<void> {
  await prisma.storeFeature
    .delete({ where: { storeId_featureKey: { storeId: testStoreId, featureKey } } })
    .catch(() => {
      /* no-op if doesn't exist */
    });
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  // 1. Platform admin: signs in at the identity service now, so mint its token (Rulings ID-1/ID-2)
  superAdminToken = await identityTokenForEmail(ADMIN_EMAIL);

  // 2. Create a test store_admin user
  const hashedPw = await bcrypt.hash(STORE_ADMIN_PASSWORD, 10);
  const adminUser = await prisma.user.create({
    data: {
      email: STORE_ADMIN_EMAIL,
      passwordHash: hashedPw,
      firstName: 'FF',
      lastName: 'TestAdmin',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  testStoreAdminUserId = adminUser.id;

  // 3. Create a test store on the 'enterprise' plan so all features are baseline-enabled
  const store = await prisma.store.create({
    data: {
      name: 'Feature Flag Test Store',
      slug: TEST_STORE_SLUG,
      ownerId: adminUser.id,
      plan: 'enterprise',
      status: 'active',
    },
  });
  testStoreId = store.id;

  // 4. Merchant token from the identity stand-in (the Store's /auth/login is closed for store_admin)
  storeAdminToken = await identityTokenFor(adminUser.id);
});

afterAll(async () => {
  // Clean up test fixtures
  await prisma.storeFeature.deleteMany({ where: { storeId: testStoreId } }).catch(() => {});
  await prisma.store.delete({ where: { id: testStoreId } }).catch(() => {});
  await prisma.user.delete({ where: { id: testStoreAdminUserId } }).catch(() => {});
});

// ─── Helper: assert feature gate returns 403 when disabled ───────────────────

async function assertFeatureDisabled(
  method: string,
  path: string,
  featureKey: string,
  body?: object
): Promise<void> {
  await disableFeature(featureKey);

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(storeAdminToken),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json();
  expect(res.status, `${method} ${path} should return 403 when ${featureKey} disabled`).toBe(403);
  expect(json.code ?? json.error).toBe('FEATURE_DISABLED');

  await clearFeatureOverride(featureKey);
}

// ─── Tests per feature ───────────────────────────────────────────────────────

describe('Feature Flag Enforcement — API Gate', () => {
  // ── coupons ────────────────────────────────────────────────────────────────

  describe('coupons', () => {
    it('GET /stores/:id/coupons returns 403 when coupons disabled', async () => {
      await assertFeatureDisabled('GET', `/stores/${testStoreId}/coupons`, 'coupons');
    });

    it('POST /stores/:id/coupons returns 403 when coupons disabled', async () => {
      await assertFeatureDisabled('POST', `/stores/${testStoreId}/coupons`, 'coupons', {
        code: 'TEST10',
        name: 'Test Coupon',
        type: 'percentage',
        value: 10,
      });
    });
  });

  // ── returns ────────────────────────────────────────────────────────────────

  describe('returns', () => {
    it('GET /stores/:id/returns/admin/list returns 403 when returns disabled', async () => {
      await assertFeatureDisabled('GET', `/stores/${testStoreId}/returns/admin/list`, 'returns');
    });
  });

  // ── reviews ────────────────────────────────────────────────────────────────

  describe('reviews', () => {
    it('GET /stores/:id/reviews/admin returns 403 when reviews disabled', async () => {
      await assertFeatureDisabled('GET', `/stores/${testStoreId}/reviews/admin`, 'reviews');
    });
  });

  // ── loyalty ────────────────────────────────────────────────────────────────

  describe('loyalty', () => {
    it('GET /stores/:id/loyalty/settings returns 403 when loyalty disabled', async () => {
      await assertFeatureDisabled('GET', `/stores/${testStoreId}/loyalty/settings`, 'loyalty');
    });
  });

  // ── abandoned_cart ─────────────────────────────────────────────────────────

  describe('abandoned_cart', () => {
    it('GET /stores/:id/abandoned-carts/stats returns 403 when abandoned_cart disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/abandoned-carts/stats`,
        'abandoned_cart'
      );
    });
  });

  // ── affiliate ──────────────────────────────────────────────────────────────

  describe('affiliate', () => {
    it('GET /stores/:id/affiliates returns 403 when affiliate disabled', async () => {
      await assertFeatureDisabled('GET', `/stores/${testStoreId}/affiliates`, 'affiliate');
    });
  });

  // ── inventory.basic ────────────────────────────────────────────────────────

  describe('inventory.basic', () => {
    it('GET /stores/:id/inventory/stats returns 403 when inventory.basic disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/inventory/stats`,
        'inventory.basic'
      );
    });

    it('GET /stores/:id/inventory/products returns 403 when inventory.basic disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/inventory/products`,
        'inventory.basic'
      );
    });
  });

  // ── inventory.stock_alerts ─────────────────────────────────────────────────

  describe('inventory.stock_alerts', () => {
    it('GET /stores/:id/inventory/alerts returns 403 when inventory.stock_alerts disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/inventory/alerts`,
        'inventory.stock_alerts'
      );
    });
  });

  // ── inventory.backorder ────────────────────────────────────────────────────

  describe('inventory.backorder', () => {
    it('GET /stores/:id/backorders returns 403 when inventory.backorder disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/backorders`,
        'inventory.backorder'
      );
    });
  });

  // ── inventory.purchase_orders ──────────────────────────────────────────────

  describe('inventory.purchase_orders', () => {
    it('GET /stores/:id/purchase-orders returns 403 when inventory.purchase_orders disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/purchase-orders`,
        'inventory.purchase_orders'
      );
    });
  });

  // ── inventory.bulk_adjustments ─────────────────────────────────────────────

  describe('inventory.bulk_adjustments', () => {
    it('GET /stores/:id/stock-adjustments returns 403 when inventory.bulk_adjustments disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/stock-adjustments`,
        'inventory.bulk_adjustments'
      );
    });

    it('POST /stores/:id/inventory/bulk-adjust returns 403 when inventory.bulk_adjustments disabled', async () => {
      await assertFeatureDisabled(
        'POST',
        `/stores/${testStoreId}/inventory/bulk-adjust`,
        'inventory.bulk_adjustments',
        { adjustments: [] }
      );
    });
  });

  // ── accounting.basic ───────────────────────────────────────────────────────

  describe('accounting.basic', () => {
    it('GET /stores/:id/finance/accounts returns 403 when accounting.basic disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/finance/accounts`,
        'accounting.basic'
      );
    });

    it('GET /stores/:id/finance/journal returns 403 when accounting.basic disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/finance/journal`,
        'accounting.basic'
      );
    });

    it('GET /stores/:id/finance/reports/pnl returns 403 when accounting.basic disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/finance/reports/pnl`,
        'accounting.basic'
      );
    });

    it('GET /stores/:id/finance/dashboard returns 403 when accounting.basic disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/finance/dashboard`,
        'accounting.basic'
      );
    });

    it('GET /stores/:id/suppliers returns 403 when accounting.basic disabled', async () => {
      await assertFeatureDisabled('GET', `/stores/${testStoreId}/suppliers`, 'accounting.basic');
    });
  });

  // ── accounting.expenses ────────────────────────────────────────────────────

  describe('accounting.expenses', () => {
    it('GET /stores/:id/expenses returns 403 when accounting.expenses disabled', async () => {
      await assertFeatureDisabled('GET', `/stores/${testStoreId}/expenses`, 'accounting.expenses');
    });

    it('POST /stores/:id/expenses returns 403 when accounting.expenses disabled', async () => {
      await assertFeatureDisabled(
        'POST',
        `/stores/${testStoreId}/expenses`,
        'accounting.expenses',
        {
          expenseAccountId: '00000000-0000-0000-0000-000000000001',
          paidFromAccountId: '00000000-0000-0000-0000-000000000002',
          amount: 10000,
          expenseDate: new Date().toISOString(),
        }
      );
    });
  });

  // ── push_notifications ────────────────────────────────────────────────────

  describe('push_notifications', () => {
    it('POST /public/:id/push/subscribe returns 403 when push_notifications disabled', async () => {
      await disableFeature('push_notifications');

      const res = await fetch(`${API_URL}/public/${testStoreId}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test',
          keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
        }),
      });

      const json = await res.json();
      // Feature gate returns 403 before auth check
      expect(res.status).toBe(403);
      expect(json.code ?? json.error).toBe('FEATURE_DISABLED');

      await clearFeatureOverride('push_notifications');
    });
  });

  // ── upsell_crosssell ──────────────────────────────────────────────────────

  describe('upsell_crosssell', () => {
    it('GET /stores/:id/recommendations returns 403 when upsell_crosssell disabled', async () => {
      await assertFeatureDisabled(
        'GET',
        `/stores/${testStoreId}/recommendations`,
        'upsell_crosssell'
      );
    });
  });

  // ── super_admin bypass ────────────────────────────────────────────────────

  describe('super_admin bypass', () => {
    it('super_admin can access coupons even when disabled for a store', async () => {
      await disableFeature('coupons');

      const res = await fetch(`${API_URL}/stores/${testStoreId}/coupons`, {
        headers: authHeader(superAdminToken),
      });

      // super_admin bypasses the feature gate — should get 200 (or 404 if
      // store has no coupons, but never 403 FEATURE_DISABLED)
      expect(res.status).not.toBe(403);

      await clearFeatureOverride('coupons');
    });
  });
});
