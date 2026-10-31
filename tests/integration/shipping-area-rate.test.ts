/**
 * Integration test: shipping area-rate API
 *
 * Coverage:
 *  1. PUT /stores/:storeId/shipping/area-rates/bulk → upserts rates; GET returns them.
 *  2. Public POST /stores/public/:storeId/shipping/calculate — known area matches,
 *     returns shippingCost + matched === true.
 *  3. Public POST with unknown area — shippingCost === 0, matched === false.
 *  4. Free-shipping threshold met — shippingCost === 0, freeShipping === true.
 *  5. RLS isolation — store B admin cannot read/modify store A area-rates; store A
 *     rates never bleed into store B GET.
 *  6. TRUNCATE shipping_area_rates in beforeAll (same prod-guard as setup-e2e.ts).
 *
 * DB SAFETY: the prod-guard in tests/setup-e2e.ts fires for any run that includes
 * "tests/integration" in argv. This file MUST NOT be run locally against the prod
 * DATABASE_URL — CI routes integration tests to a disposable Postgres service container.
 *
 * Mirrors: tests/integration/api.test.ts (fetch-based HTTP pattern + live server)
 *          tests/integration/warehouse-crud.test.ts (withRlsBypass setup/teardown)
 *          tests/integration/tenant-isolation.test.ts (two-store RLS isolation)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma, withRlsBypass } from '@ebda/database';
import { API_BASE, API_ORIGIN } from '../helpers/api-base';
import { identityTokenFor } from '../helpers/identity-session';

// One knob (TEST_API_URL) points the whole suite at one API, so a run cannot
// silently talk to whatever holds port 4000 — which on this machine was a
// different project's dev server for five days. See tests/helpers/api-base.ts.
const API_URL = API_BASE;
const S = `ar-${Date.now()}`;

// ─── Store A (the primary test store) ────────────────────────────────────────
let storeAId: string;
let storeAToken: string;

// ─── Store B (RLS isolation witness) ─────────────────────────────────────────
let storeBId: string;
let storeBToken: string;

// ─── Helper: create user + store, log in, return access token ─────────────────

async function createStoreAndLogin(label: string): Promise<{ storeId: string; token: string }> {
  const email = `${S}-${label}@test.local`;
  const password = 'Test!12345';
  const hash = await bcrypt.hash(password, 10);

  const user = await withRlsBypass(async tx => {
    return tx.user.create({
      data: {
        email,
        passwordHash: hash,
        firstName: label,
        lastName: 'Test',
        role: 'store_admin',
        emailVerified: true,
        status: 'active',
      },
    });
  });

  const store = await withRlsBypass(async tx => {
    return tx.store.create({
      data: {
        name: `Area Rate Test Store ${label}`,
        slug: `ar-test-${S}-${label}`,
        ownerId: user.id,
        plan: 'professional',
        status: 'active',
      },
    });
  });

  // Store admins sign in at the identity service; the stand-in mints its token.
  const token = await identityTokenFor(user.id);

  return { storeId: store.id, token };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Preflight: fail with a clear message if the API this suite targets isn't
  // actually up, rather than letting every request below fail individually
  // with a connection-refused error that looks like a test-by-test failure.
  const health = await fetch(`${API_ORIGIN}/health`);
  expect(health.status, `API at ${API_ORIGIN} is not healthy — is it running?`).toBe(200);

  // Truncate area-rates so prior CI runs don't leave conflicting unique rows.
  // TRUNCATE is not subject to RLS and reliably clears stale data; the prod-guard
  // in setup-e2e.ts refuses to run this file against the production database.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE shipping_area_rates RESTART IDENTITY CASCADE`);

  // Create two stores with their admins.
  const a = await createStoreAndLogin('storeA');
  storeAId = a.storeId;
  storeAToken = a.token;

  const b = await createStoreAndLogin('storeB');
  storeBId = b.storeId;
  storeBToken = b.token;
});

// ─── Teardown ─────────────────────────────────────────────────────────────────

afterAll(async () => {
  await withRlsBypass(async tx => {
    await tx.shippingAreaRate.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } });
    await tx.store.deleteMany({ where: { id: { in: [storeAId, storeBId] } } });
    await tx.user.deleteMany({ where: { email: { contains: `${S}-` } } });
  });
  await prisma.$disconnect();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PUT /stores/:storeId/shipping/area-rates/bulk + GET', () => {
  it('bulk-upserts two area rates and GET returns both', async () => {
    const putRes = await fetch(`${API_URL}/stores/${storeAId}/shipping/area-rates/bulk`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeAToken}`,
      },
      body: JSON.stringify({
        rates: [
          {
            governorate: 'Hawalli',
            governorateAr: 'حولي',
            area: 'Salmiya',
            areaAr: 'السالمية',
            deliveryFee: 1500,
            isActive: true,
          },
          {
            governorate: 'Ahmadi',
            governorateAr: 'الأحمدي',
            area: 'Khairan',
            areaAr: 'الخيران',
            deliveryFee: 4000,
            isActive: true,
          },
        ],
      }),
    });

    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as {
      success: boolean;
      data: { rates: Array<{ area: string; deliveryFee: number }> };
    };
    expect(putJson.success).toBe(true);
    expect(putJson.data.rates.length).toBeGreaterThanOrEqual(2);

    // GET must return both
    const getRes = await fetch(`${API_URL}/stores/${storeAId}/shipping/area-rates`, {
      headers: { Authorization: `Bearer ${storeAToken}` },
    });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      success: boolean;
      data: { rates: Array<{ area: string; deliveryFee: number }> };
    };
    expect(getJson.success).toBe(true);
    const areas = getJson.data.rates.map(r => r.area);
    expect(areas).toContain('Salmiya');
    expect(areas).toContain('Khairan');
    const salmiya = getJson.data.rates.find(r => r.area === 'Salmiya');
    expect(salmiya?.deliveryFee).toBe(1500);
  });
});

describe('POST /stores/public/:storeId/shipping/calculate', () => {
  it('returns shippingCost=1500, matched=true for Salmiya/Hawalli', async () => {
    const res = await fetch(`${API_URL}/stores/public/${storeAId}/shipping/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        governorate: 'Hawalli',
        area: 'Salmiya',
        orderTotal: 5000,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { shippingCost: number; matched: boolean; freeShipping: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.shippingCost).toBe(1500);
    expect(json.data.matched).toBe(true);
    expect(json.data.freeShipping).toBe(false);
  });

  it('returns shippingCost=0, matched=false for unknown area (Jahra/Kabd — no rate, no zone)', async () => {
    const res = await fetch(`${API_URL}/stores/public/${storeAId}/shipping/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        governorate: 'Jahra',
        area: 'Kabd',
        orderTotal: 5000,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { shippingCost: number; matched: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.shippingCost).toBe(0);
    expect(json.data.matched).toBe(false);
  });

  it('returns freeShipping=true when orderTotal meets freeShippingThreshold', async () => {
    // Seed a rate with freeShippingThreshold=10000 piastres (≈1 EGP)
    await withRlsBypass(async tx => {
      await tx.shippingAreaRate.upsert({
        where: {
          storeId_country_governorate_area: {
            storeId: storeAId,
            country: 'Egypt',
            governorate: 'Cairo',
            area: 'Sharq',
          },
        },
        create: {
          storeId: storeAId,
          governorate: 'Cairo',
          governorateAr: 'القاهرة',
          area: 'Sharq',
          areaAr: 'شرق',
          deliveryFee: 2000,
          freeShippingThreshold: 10000,
          isActive: true,
        },
        update: {
          deliveryFee: 2000,
          freeShippingThreshold: 10000,
          isActive: true,
        },
      });
    });

    const res = await fetch(`${API_URL}/stores/public/${storeAId}/shipping/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        governorate: 'Cairo',
        area: 'Sharq',
        orderTotal: 15000, // exceeds 10000 threshold → free
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { shippingCost: number; matched: boolean; freeShipping: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.matched).toBe(true);
    expect(json.data.shippingCost).toBe(0);
    expect(json.data.freeShipping).toBe(true);
  });
});

describe('RLS tenant isolation — store B cannot access store A area-rates', () => {
  it('store B admin token gets 403 on GET store A area-rates', async () => {
    const res = await fetch(`${API_URL}/stores/${storeAId}/shipping/area-rates`, {
      headers: { Authorization: `Bearer ${storeBToken}` },
    });
    // requireStoreAccess (middleware/store-access.ts) 404s only when the
    // store row itself doesn't exist; storeA is real, so a store_admin who
    // doesn't own it always gets exactly 403 (AppError(403, 'FORBIDDEN', …)).
    // The old [403, 404] pair could not tell "the guard correctly rejected
    // me" from "there is no such route/store" — the same ambiguity the
    // login assertion above closes for the token itself.
    expect(res.status).toBe(403);
  });

  it('store B admin token gets 403 on PUT bulk for store A', async () => {
    const res = await fetch(`${API_URL}/stores/${storeAId}/shipping/area-rates/bulk`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeBToken}`,
      },
      body: JSON.stringify({
        rates: [
          {
            governorate: 'Hawalli',
            governorateAr: 'حولي',
            area: 'Salmiya',
            areaAr: 'السالمية',
            deliveryFee: 9999,
          },
        ],
      }),
    });
    expect(res.status).toBe(403);
  });

  it('store A rates do not appear in store B GET (no cross-store leakage)', async () => {
    const res = await fetch(`${API_URL}/stores/${storeBId}/shipping/area-rates`, {
      headers: { Authorization: `Bearer ${storeBToken}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { rates: Array<{ area: string }> };
    };
    const areas = json.data.rates.map(r => r.area);
    // Store A's Salmiya rate must NOT appear in store B's listing
    expect(areas).not.toContain('Salmiya');
    expect(areas).not.toContain('Khairan');
  });

  it('store B can manage its own area-rates independently', async () => {
    const res = await fetch(`${API_URL}/stores/${storeBId}/shipping/area-rates/bulk`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${storeBToken}`,
      },
      body: JSON.stringify({
        rates: [
          {
            governorate: 'Farwaniya',
            governorateAr: 'الفروانية',
            area: 'Omariya',
            areaAr: 'العمارية',
            deliveryFee: 3000,
            isActive: true,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { rates: Array<{ area: string; deliveryFee: number }> };
    };
    expect(json.success).toBe(true);
    const omariya = json.data.rates.find(r => r.area === 'Omariya');
    expect(omariya?.deliveryFee).toBe(3000);
  });
});
