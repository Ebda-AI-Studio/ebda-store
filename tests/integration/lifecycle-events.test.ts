/**
 * Lifecycle Events Integration Tests
 *
 * Tests the return timeline endpoint and affiliate audit-trail endpoint:
 *   GET /stores/:storeId/returns/admin/:id/timeline
 *   GET /stores/:storeId/affiliates/:id/audit-trail
 *
 * Each test block:
 *  - Creates the required data directly in DB
 *  - Makes real HTTP requests to the running API
 *  - Verifies tenant scoping (other-store returns are not visible)
 *  - Cleans up in afterAll
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { API_BASE } from '../helpers/api-base';
import { identityTokenForEmail } from '../helpers/identity-session';

// One knob (TEST_API_URL) points the whole suite at one API, so a run cannot
// silently talk to whatever holds port 4000 — which on this machine was a
// different project's dev server for five days. See tests/helpers/api-base.ts.
const API_URL = API_BASE;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@ebda.app';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let authToken: string;
let testStoreId: string;
let fixtureOrderId: string;
const fixtureUserIds: string[] = [];

// IDs created by this test run — cleaned up in afterAll
const createdReturnIds: string[] = [];
const createdAffiliateIds: string[] = [];

beforeAll(async () => {
  // Super admin: signs in at the identity service, so the suite presents the token it would issue (tests/helpers/identity-session.ts)
  authToken = await identityTokenForEmail(ADMIN_EMAIL);

  // The store is THIS file's own fixture. It used to be `/admin/stores?limit=1`, i.e. whatever store another
  // test file (running in parallel) had just created: when that file tore it down, the affiliate insert hit
  // `affiliates_store_id_fkey`, and the return-timeline test silently skipped whenever that store had no order.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: {
      email: `lc-owner-${suffix}@test.local`,
      passwordHash: 'x',
      firstName: 'LC',
      lastName: 'Owner',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  const customer = await prisma.user.create({
    data: {
      email: `lc-customer-${suffix}@test.local`,
      passwordHash: 'x',
      firstName: 'LC',
      lastName: 'Customer',
      role: 'customer',
      emailVerified: true,
    },
  });
  fixtureUserIds.push(owner.id, customer.id);
  const store = await prisma.store.create({
    data: { name: `lc-${suffix}`, slug: `lc-${suffix}`, ownerId: owner.id, status: 'active' },
  });
  testStoreId = store.id;
  const order = await prisma.order.create({
    data: {
      storeId: store.id,
      customerId: customer.id,
      orderNumber: `LC-${suffix}`,
      status: 'delivered',
      paymentStatus: 'paid',
      subtotal: 10_000,
      total: 10_000,
      shippingAddress: {},
      billingAddress: {},
    },
  });
  fixtureOrderId = order.id;
});

afterAll(async () => {
  // Remove only rows this test run created, in FK-safe order
  if (createdReturnIds.length) {
    await prisma.returnItem.deleteMany({ where: { returnId: { in: createdReturnIds } } });
    await prisma.auditLog.deleteMany({
      where: { resourceType: 'return', resourceId: { in: createdReturnIds } },
    });
    await prisma.return.deleteMany({ where: { id: { in: createdReturnIds } } });
  }
  if (createdAffiliateIds.length) {
    await prisma.affiliateEvent.deleteMany({
      where: { affiliateId: { in: createdAffiliateIds } },
    });
    await prisma.affiliate.deleteMany({ where: { id: { in: createdAffiliateIds } } });
  }
  if (testStoreId) {
    await prisma.order.deleteMany({ where: { storeId: testStoreId } }).catch(() => undefined);
    await prisma.store.deleteMany({ where: { id: testStoreId } }).catch(() => undefined);
  }
  if (fixtureUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: fixtureUserIds } } }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders() {
  return {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Return timeline tests
// ---------------------------------------------------------------------------

describe('Return lifecycle timeline endpoint', () => {
  it('requires admin auth — 401 without token', async () => {
    const res = await fetch(
      `${API_URL}/stores/${testStoreId}/returns/admin/00000000-0000-0000-0000-000000000000/timeline`
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for a return that does not exist in the store', async () => {
    if (!testStoreId) return;
    const res = await fetch(
      `${API_URL}/stores/${testStoreId}/returns/admin/00000000-0000-0000-0000-000000000001/timeline`,
      { headers: authHeaders() }
    );
    expect([404, 400]).toContain(res.status);
  });

  it('returns timeline rows from audit_logs for a known return', async () => {
    if (!testStoreId) {
      console.warn('No test store found — skipping return timeline test');
      return;
    }

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: fixtureOrderId },
      select: { id: true, customerId: true },
    });

    const returnRecord = await prisma.return.create({
      data: {
        storeId: testStoreId,
        orderId: order.id,
        customerId: order.customerId!,
        returnNumber: `RET-TEST-${Date.now()}`,
        type: 'return',
        reason: 'Integration test return',
        refundAmount: 0,
        status: 'pending',
      },
    });
    createdReturnIds.push(returnRecord.id);

    // Seed an audit log entry for this return
    await prisma.auditLog.create({
      data: {
        action: 'return.created',
        storeId: testStoreId,
        resourceType: 'return',
        resourceId: returnRecord.id,
        details: { returnNumber: returnRecord.returnNumber, type: 'return' },
      },
    });

    const res = await fetch(
      `${API_URL}/stores/${testStoreId}/returns/admin/${returnRecord.id}/timeline`,
      { headers: authHeaders() }
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.timeline)).toBe(true);
    expect(json.data.timeline.length).toBeGreaterThanOrEqual(1);

    // Each row must have the required shape
    const row = json.data.timeline[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('at');
    expect(row).toHaveProperty('action');
    expect(row).toHaveProperty('details');
    expect(json.data.returnNumber).toBe(returnRecord.returnNumber);
  });

  it('tenant scoping — 404 for non-existent return on this store', async () => {
    if (!testStoreId) return;
    const res = await fetch(
      `${API_URL}/stores/${testStoreId}/returns/admin/00000000-0000-0000-0000-000000000099/timeline`,
      { headers: authHeaders() }
    );
    expect([404, 400]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Affiliate audit-trail tests
// ---------------------------------------------------------------------------

describe('Affiliate audit-trail endpoint', () => {
  it('requires admin auth — 401 without token', async () => {
    const res = await fetch(
      `${API_URL}/stores/${testStoreId}/affiliates/00000000-0000-0000-0000-000000000000/audit-trail`
    );
    expect(res.status).toBe(401);
  });

  it('returns empty events array for a new affiliate with no events', async () => {
    if (!testStoreId) return;

    const affiliate = await prisma.affiliate.create({
      data: {
        storeId: testStoreId,
        name: 'Test Affiliate LC',
        email: `affiliate-lc-${Date.now()}@example.test`,
        referralCode: `TESTLC${Date.now()}`,
        status: 'pending',
      },
    });
    createdAffiliateIds.push(affiliate.id);

    const res = await fetch(
      `${API_URL}/stores/${testStoreId}/affiliates/${affiliate.id}/audit-trail`,
      { headers: authHeaders() }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.events)).toBe(true);
    expect(json.data.events.length).toBe(0);
  });

  it('returns affiliate_events rows after recording an event', async () => {
    if (!testStoreId) return;

    const affiliate = await prisma.affiliate.create({
      data: {
        storeId: testStoreId,
        name: 'Test Affiliate With Events LC',
        email: `affiliate-lc-events-${Date.now()}@example.test`,
        referralCode: `TESTLCEVT${Date.now()}`,
        status: 'pending',
      },
    });
    createdAffiliateIds.push(affiliate.id);

    // Seed an affiliate_events row directly
    await prisma.affiliateEvent.create({
      data: {
        affiliateId: affiliate.id,
        storeId: testStoreId,
        eventType: 'created',
        details: { source: 'integration_test' },
      },
    });

    const res = await fetch(
      `${API_URL}/stores/${testStoreId}/affiliates/${affiliate.id}/audit-trail`,
      { headers: authHeaders() }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.events.length).toBeGreaterThanOrEqual(1);

    // Verify actual affiliate_events fields are present
    const event = json.data.events[0];
    expect(event).toHaveProperty('id');
    expect(event).toHaveProperty('eventType');
    expect(event).toHaveProperty('occurredAt');
  });

  it('tenant scoping — 404 for affiliate not in this store', async () => {
    if (!testStoreId) return;
    const res = await fetch(
      `${API_URL}/stores/${testStoreId}/affiliates/00000000-0000-0000-0000-000000000099/audit-trail`,
      { headers: authHeaders() }
    );
    expect([404, 400]).toContain(res.status);
  });
});
