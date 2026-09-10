/**
 * Integration tests for Task 5 — super-admin answer-engine provider config
 * (encrypted API keys + enabled toggle).
 *
 * Requires a real Postgres DB (via DATABASE_URL) and real Redis (via
 * REDIS_URL); hits a real running API server at localhost:4000. Mirrors the
 * harness pattern used by tests/integration/agent-feed.test.ts and
 * tests/integration/token-revocation.test.ts (real login → real JWT, not a
 * hand-crafted token).
 *
 * Covers the full secret-handling contract for
 * GET/PUT /admin/answer-engine/providers[/:engine]:
 *   1. PUT with a plaintext apiKey → 200, and the DB row's `api_key` column
 *      is NOT the plaintext (it's encrypted at rest).
 *   2. GET → the row comes back with apiKeyMasked containing `****` and
 *      never containing the plaintext.
 *   3. A second PUT sent with the MASKED value round-tripped (as a naive
 *      client would do on an untouched field) does NOT clobber the stored
 *      secret — it still decrypts to the original plaintext — while
 *      `enabled` still flips as requested.
 *   4. A non-super-admin (store_admin) caller gets 403 on both verbs.
 *   5. (Fix wave 1) A super_admin WITHOUT MFA enrolled gets 403
 *      MFA_SETUP_REQUIRED on both verbs — this router is now MFA-gated the
 *      same as feature.routes.ts / insights.routes.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { encryption } from '../../../apps/api/src/services/encryption.service';
import { API_BASE } from '../../helpers/api-base';

// One knob (TEST_API_URL) configures the whole integration suite; see
// tests/helpers/api-base.ts for why it is not the server's own API_URL — the
// encryption.service import above runs dotenv.config() before this line.
const API_URL = API_BASE;

const PW = 'Test1234!pw';
const PLAINTEXT_KEY = 'pplx-secret-123';

let superAdminToken: string;
let storeAdminToken: string;
let noMfaSuperAdminToken: string;
const createdUserIds: string[] = [];

async function createUserAndLogin(role: 'super_admin' | 'store_admin'): Promise<string> {
  const email = `aei-provider-cfg-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PW, 10),
      firstName: 'AEI',
      lastName: role === 'super_admin' ? 'SuperAdmin' : 'StoreAdmin',
      role,
      emailVerified: true,
      storeId: null,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`login failed for ${role} (${res.status}): ${body}`);
  }
  const json = await res.json();
  return json.data.accessToken as string;
}

/**
 * Create a super_admin, enroll real TOTP MFA on them (begin → verify), then
 * log in again and complete the MFA challenge — mirroring the
 * "enrolled super_admin" flow in tests/integration/mfa-enforcement.test.ts.
 * Returns a fully-enrolled access token that clears `requireMfaEnrolled`.
 */
async function createMfaEnrolledSuperAdminAndLogin(): Promise<string> {
  const email = `aei-provider-cfg-mfa-super-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PW, 10),
      firstName: 'AEI',
      lastName: 'MfaSuperAdmin',
      role: 'super_admin',
      emailVerified: true,
      storeId: null,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  // First login (not yet enrolled) → normal access token.
  const loginRes = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!loginRes.ok) {
    throw new Error(
      `login failed for mfa super_admin (${loginRes.status}): ${await loginRes.text()}`
    );
  }
  const loginJson = await loginRes.json();
  const preEnrollToken = loginJson.data.accessToken as string;

  // Begin + verify TOTP enrollment.
  const beginRes = await fetch(`${API_URL}/auth/mfa/enroll/begin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${preEnrollToken}` },
  });
  if (!beginRes.ok) {
    throw new Error(`mfa enroll/begin failed (${beginRes.status}): ${await beginRes.text()}`);
  }
  const beginJson = await beginRes.json();
  const secret = beginJson.data.secret as string;

  const verifyEnrollRes = await fetch(`${API_URL}/auth/mfa/enroll/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preEnrollToken}` },
    body: JSON.stringify({ code: authenticator.generate(secret) }),
  });
  if (!verifyEnrollRes.ok) {
    throw new Error(
      `mfa enroll/verify failed (${verifyEnrollRes.status}): ${await verifyEnrollRes.text()}`
    );
  }

  // Second login → MFA challenge required.
  const login2Res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  const login2Json = await login2Res.json();
  const challengeToken = login2Json.data.challengeToken as string;

  const mfaVerifyRes = await fetch(`${API_URL}/auth/mfa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken, code: authenticator.generate(secret) }),
  });
  if (!mfaVerifyRes.ok) {
    throw new Error(`mfa verify failed (${mfaVerifyRes.status}): ${await mfaVerifyRes.text()}`);
  }
  const mfaVerifyJson = await mfaVerifyRes.json();
  return mfaVerifyJson.data.accessToken as string;
}

function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  superAdminToken = await createMfaEnrolledSuperAdminAndLogin();
  storeAdminToken = await createUserAndLogin('store_admin');
  noMfaSuperAdminToken = await createUserAndLogin('super_admin');
});

afterAll(async () => {
  await prisma.answerEngineProviderConfig
    .deleteMany({ where: { engine: { in: ['perplexity', 'openai'] } } })
    .catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
});

describe('PUT/GET /admin/answer-engine/providers — encrypted key + mask discipline', () => {
  it('PUT with a plaintext apiKey stores it ENCRYPTED (never plaintext) and sets enabled', async () => {
    const res = await fetch(`${API_URL}/admin/answer-engine/providers/perplexity`, {
      method: 'PUT',
      headers: authHeaders(superAdminToken),
      body: JSON.stringify({ apiKey: PLAINTEXT_KEY, enabled: true }),
    });
    expect(res.status).toBe(200);

    const row = await prisma.answerEngineProviderConfig.findUnique({
      where: { engine: 'perplexity' },
    });
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(true);
    expect(row!.apiKey).not.toBeNull();
    expect(row!.apiKey).not.toBe(PLAINTEXT_KEY);
    expect(row!.apiKey).not.toContain(PLAINTEXT_KEY);
    // Round-trips back to the original plaintext via the real encryption service.
    expect(encryption.decrypt(row!.apiKey!)).toBe(PLAINTEXT_KEY);
  });

  it('GET returns the key MASKED (contains ****, never the plaintext)', async () => {
    const res = await fetch(`${API_URL}/admin/answer-engine/providers`, {
      method: 'GET',
      headers: authHeaders(superAdminToken),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    const configs = body.data.configs as Array<{
      engine: string;
      enabled: boolean;
      apiKeyMasked: string | null;
    }>;
    const perplexity = configs.find(c => c.engine === 'perplexity');
    expect(perplexity).toBeDefined();
    expect(perplexity!.enabled).toBe(true);
    expect(perplexity!.apiKeyMasked).not.toBeNull();
    expect(perplexity!.apiKeyMasked).toContain('****');
    expect(perplexity!.apiKeyMasked).not.toContain(PLAINTEXT_KEY);

    // Belt-and-suspenders: plaintext must not appear ANYWHERE in the raw
    // response body (catches a leak in a field this test doesn't name).
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(PLAINTEXT_KEY);
  });

  it('a second PUT with the masked sentinel value does NOT clobber the stored secret', async () => {
    // Fetch the masked value exactly as the admin UI would round-trip it.
    const getRes = await fetch(`${API_URL}/admin/answer-engine/providers`, {
      headers: authHeaders(superAdminToken),
    });
    const getBody = await getRes.json();
    const perplexity = (
      getBody.data.configs as Array<{ engine: string; apiKeyMasked: string | null }>
    ).find(c => c.engine === 'perplexity')!;
    expect(perplexity.apiKeyMasked).toContain('****');

    const putRes = await fetch(`${API_URL}/admin/answer-engine/providers/perplexity`, {
      method: 'PUT',
      headers: authHeaders(superAdminToken),
      body: JSON.stringify({ apiKey: perplexity.apiKeyMasked, enabled: false }),
    });
    expect(putRes.status).toBe(200);

    const row = await prisma.answerEngineProviderConfig.findUnique({
      where: { engine: 'perplexity' },
    });
    expect(row!.enabled).toBe(false);
    // The stored ciphertext still decrypts to the ORIGINAL plaintext — the
    // masked round-trip must not have overwritten it with mask text or
    // anything else.
    expect(encryption.decrypt(row!.apiKey!)).toBe(PLAINTEXT_KEY);
  });

  it('a non-super-admin (store_admin) caller gets 403 on GET and PUT', async () => {
    const getRes = await fetch(`${API_URL}/admin/answer-engine/providers`, {
      headers: authHeaders(storeAdminToken),
    });
    expect(getRes.status).toBe(403);

    const putRes = await fetch(`${API_URL}/admin/answer-engine/providers/perplexity`, {
      method: 'PUT',
      headers: authHeaders(storeAdminToken),
      body: JSON.stringify({ apiKey: 'whatever', enabled: true }),
    });
    expect(putRes.status).toBe(403);
  });

  it('a super_admin WITHOUT MFA enrolled is blocked (403 MFA_SETUP_REQUIRED) on GET and PUT', async () => {
    const getRes = await fetch(`${API_URL}/admin/answer-engine/providers`, {
      headers: authHeaders(noMfaSuperAdminToken),
    });
    expect(getRes.status).toBe(403);
    const getBody = await getRes.json();
    expect(getBody.error.code).toBe('MFA_SETUP_REQUIRED');

    const putRes = await fetch(`${API_URL}/admin/answer-engine/providers/perplexity`, {
      method: 'PUT',
      headers: authHeaders(noMfaSuperAdminToken),
      body: JSON.stringify({ apiKey: 'whatever', enabled: true }),
    });
    expect(putRes.status).toBe(403);
    const putBody = await putRes.json();
    expect(putBody.error.code).toBe('MFA_SETUP_REQUIRED');
  });
});
