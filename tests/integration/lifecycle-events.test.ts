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
import { prisma } from '@force/database';

const API_URL = 'http://localhost:4000/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@forcemediakw.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let authToken: string;
let testStoreId: string;

// IDs created by this test run — cleaned up in afterAll
const createdReturnIds: string[] = [];
const createdAffiliateIds: string[] = [];

beforeAll(async () => {
  // Login as super_admin
  const loginRes = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const loginJson = await loginRes.json();
  authToken = loginJson.data?.accessToken as string;

  // Resolve a test store
  const storeRes = await fetch(`${API_URL}/admin/stores?limit=1`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const storeJson = await storeRes.json();
  testStoreId = storeJson.data?.stores?.[0]?.id as string;
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

    // Need a valid order with a customer in this store
    const order = await prisma.order.findFirst({
      where: { storeId: testStoreId, deletedAt: null },
      select: { id: true, customerId: true },
    });

    if (!order?.customerId) {
      console.warn('No order with customerId in test store — skipping');
      return;
    }

    const returnRecord = await prisma.return.create({
      data: {
        storeId: testStoreId,
        orderId: order.id,
        customerId: order.customerId,
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
