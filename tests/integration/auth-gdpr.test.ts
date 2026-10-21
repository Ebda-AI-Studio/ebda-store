/**
 * GDPR Art. 17 + 20 and applicable GCC data-protection law (see
 * docs/privacy/data-map.md) endpoints:
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
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import { API_BASE } from '../helpers/api-base';
import { AuthService } from '../../apps/api/src/services/auth.service';

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

  // A storefront customer always belongs to a store (registration without a
  // storeId is refused), and the tenant guard scopes every erase/export row to
  // that store.
  const suffix = Math.random().toString(36).slice(2, 8);
  const owner = await prisma.user.create({
    data: {
      email: `gdpr-owner-${Date.now()}-${suffix}@example.test`,
      passwordHash,
      firstName: 'Store',
      lastName: 'Owner',
      role: 'store_admin',
      emailVerified: true,
    },
    select: { id: true },
  });
  const store = await prisma.store.create({
    data: { name: `gdpr-${suffix}`, slug: `gdpr-${Date.now()}-${suffix}`, ownerId: owner.id },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: 'Privacy',
      lastName: 'Tester',
      role: 'customer',
      storeId: store.id,
      emailVerified: true, // must be true so /auth/login issues tokens
    },
    select: { id: true },
  });

  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: GDPR_TEST_PASSWORD, storeId: store.id }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`login failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  return {
    email,
    userId: user.id,
    storeId: store.id,
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

    // Read the result straight from the DB: the access token that performed
    // the erase is dead afterwards (#1871, asserted below), so it can no
    // longer be used to export the anonymized bundle.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(user.email).toMatch(/^erased-.*@anonymized\.local$/);
    expect(user.firstName).toBe('Erased');
    expect(user.lastName).toBe('User');
    expect(user.phone).toBeNull();
    expect(user.avatar).toBeNull();
    expect(user.dateOfBirth).toBeNull();
    expect(user.status).toBe('inactive');
    expect(user.deletedAt).not.toBeNull();
    // PII-only child rows are gone — addresses, push, loyalty, etc.
    const where = { userId: u.userId };
    expect(await prisma.address.count({ where })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { customerId: u.userId } })).toBe(0);
    expect(await prisma.oneSignalSubscription.count({ where })).toBe(0);
    expect(await prisma.loyaltyPoints.count({ where: { customerId: u.userId } })).toBe(0);
    expect(await prisma.loyaltyTransaction.count({ where: { customerId: u.userId } })).toBe(0);
  });

  it('kills the access token that was live at erase time (#1871)', async () => {
    const u = await registerCustomer();

    const before = await fetch(`${API_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${u.accessToken}` },
    });
    expect(before.status).toBe(200);

    const eraseRes = await fetch(`${API_URL}/auth/me/erase`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${u.accessToken}` },
    });
    expect(eraseRes.status).toBe(200);

    // The tv cache was warm from the request above, so this rejects only if
    // the erase bumped tokenVersion AND pushed it into the cache.
    const after = await fetch(`${API_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${u.accessToken}` },
    });
    expect(after.status).toBe(401);
  });

  it('erase is idempotent: a second erase of the same account succeeds', async () => {
    const u = await registerCustomer();

    const first = await fetch(`${API_URL}/auth/me/erase`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${u.accessToken}` },
    });
    expect(first.status).toBe(200);

    // The shopper's own token is revoked by the first erase, so the second
    // pass is the path that repeats in practice: the retention cron
    // re-running over an already-erased row.
    await expect(AuthService.eraseAccount(u.userId)).resolves.toBeDefined();
  });

  it('rejects unauthenticated erase requests', async () => {
    const res = await fetch(`${API_URL}/auth/me/erase`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
