/**
 * GDPR Art. 17 + 20 and applicable GCC data-protection law (see
 * docs/legal/gcc-data-protection.md) endpoints:
 *   POST /auth/me/erase  — irreversible PII anonymization
 *   GET  /auth/me/export — right to data portability
 *
 * Hits the running API at http://localhost:4000 against the integration
 * Postgres + Redis from tests/setup.ts. Each test owns its own freshly
 * created customer so erasing one doesn't poison the others.
 *
 * We create test users directly via Prisma with emailVerified=true rather
 * than going through POST /auth/register, because registration now gates
 * token issuance behind email verification (correct prod behavior). Tests
 * must not depend on /auth/register returning tokens.
 */

import { describe, it, expect } from 'vitest';
import { prisma } from '@force/database';
import bcrypt from 'bcryptjs';
import { API_BASE } from '../helpers/api-base';

// One knob (TEST_API_URL) configures the whole integration suite. Neither the
// server's API_URL nor its API_HOST is read here: API_HOST is a BARE HOSTNAME
// ("localhost") that dotenv injects at API-module import time, which would
// build the invalid "localhost/api/v1". See tests/helpers/api-base.ts.
const API_URL = API_BASE;

const GDPR_TEST_PASSWORD = 'GdprTest!234';

/**
 * Create a verified customer in the DB and log them in to get an access
 * token. Bypasses the email-verification step that POST /auth/register
 * now enforces.
 */
async function registerCustomer() {
  const email = `gdpr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const passwordHash = await bcrypt.hash(GDPR_TEST_PASSWORD, 10);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: 'Privacy',
      lastName: 'Tester',
      role: 'customer',
      emailVerified: true, // must be true so /auth/login issues tokens
    },
    select: { id: true },
  });

  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: GDPR_TEST_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`login failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  return {
    email,
    userId: user.id,
    accessToken: json.data.accessToken as string,
  };
}

describe('GDPR erase + export endpoints', () => {
  it('exports the authenticated user as a JSON bundle with all PII surfaces', async () => {
    const u = await registerCustomer();

    const res = await fetch(`${API_URL}/auth/me/export`, {
      headers: { Authorization: `Bearer ${u.accessToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    expect(res.headers.get('content-disposition') ?? '').toContain('attachment');

    const bundle = await res.json();
    expect(bundle.exportedAt).toBeDefined();
    expect(bundle.user?.id).toBe(u.userId);
    expect(bundle.user?.email).toBe(u.email);
    expect(Array.isArray(bundle.addresses)).toBe(true);
    expect(Array.isArray(bundle.orders)).toBe(true);
    expect(Array.isArray(bundle.abandonedCarts)).toBe(true);
    expect(Array.isArray(bundle.wishlists)).toBe(true);
    expect(Array.isArray(bundle.reviews)).toBe(true);
    expect(Array.isArray(bundle.returns)).toBe(true);
    expect(Array.isArray(bundle.loyaltyPoints)).toBe(true);
    expect(Array.isArray(bundle.loyaltyTransactions)).toBe(true);
    expect(Array.isArray(bundle.pushSubscriptions)).toBe(true);
    expect(Array.isArray(bundle.onesignalSubscriptions)).toBe(true);
  });

  it('rejects unauthenticated export requests', async () => {
    const res = await fetch(`${API_URL}/auth/me/export`);
    expect(res.status).toBe(401);
  });

  it('erases PII irreversibly: email rewritten, deletedAt set, PII fields cleared', async () => {
    const u = await registerCustomer();

    const eraseRes = await fetch(`${API_URL}/auth/me/erase`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${u.accessToken}` },
    });
    expect(eraseRes.status).toBe(200);

    // Re-export via the JWT — it's still valid (passwordHash rotates
    // but the in-flight JWT signed against the old payload doesn't
    // get revoked until expiry). The exported bundle should show the
    // anonymized identity.
    const exportRes = await fetch(`${API_URL}/auth/me/export`, {
      headers: { Authorization: `Bearer ${u.accessToken}` },
    });
    expect(exportRes.status).toBe(200);
    const bundle = await exportRes.json();
    expect(bundle.user.email).toMatch(/^erased-.*@anonymized\.local$/);
    expect(bundle.user.firstName).toBe('Erased');
    expect(bundle.user.lastName).toBe('User');
    expect(bundle.user.phone).toBeNull();
    expect(bundle.user.avatar).toBeNull();
    expect(bundle.user.dateOfBirth).toBeNull();
    expect(bundle.user.status).toBe('inactive');
    // PII-only child rows are gone — addresses, push, loyalty, etc.
    expect(bundle.addresses).toHaveLength(0);
    expect(bundle.pushSubscriptions).toHaveLength(0);
    expect(bundle.onesignalSubscriptions).toHaveLength(0);
    expect(bundle.loyaltyPoints).toHaveLength(0);
    expect(bundle.loyaltyTransactions).toHaveLength(0);
  });

  it('erase is idempotent: a second call on the same account succeeds', async () => {
    const u = await registerCustomer();

    const first = await fetch(`${API_URL}/auth/me/erase`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${u.accessToken}` },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${API_URL}/auth/me/erase`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${u.accessToken}` },
    });
    expect(second.status).toBe(200);
  });

  it('rejects unauthenticated erase requests', async () => {
    const res = await fetch(`${API_URL}/auth/me/erase`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
