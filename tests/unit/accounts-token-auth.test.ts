/**
 * The Store verifies identity-service tokens (Rulings ID-1/ID-2): ES256 only, exact issuer/audience/type, JWKS from the
 * identity Worker, per-request revocation, role mapping. Contract: business/ebda/plans/2026-10-24-ebda-identity-token-contract.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isJtiDenied: () => Promise.resolve(false),
    getUserTokenVersion: () => Promise.resolve(0),
    setUserTokenVersion: () => Promise.resolve(),
  },
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));
// The Store's own profile row (ebda_user_state definer), per user id.
const rows = new Map<
  string,
  {
    id: string;
    role: string;
    status: string;
    tokenVersion: number;
    storeId: string | null;
    deletedAt: Date | null;
  }
>();
vi.mock('../../apps/api/src/lib/definer', () => ({
  getUserState: async (id: string) => rows.get(id) ?? null,
}));

vi.mock('../../apps/api/src/lib/identity-client', () => ({
  // The identity service is the ONE authority for existence + status (Ruling NZ-D2); `rows` stands in for it here.
  getAccountState: async (id: string) => {
    const r = rows.get(id);
    return r && !r.deletedAt ? { id, role: r.role, status: r.status } : null;
  },
}));

const { authenticate, optionalAuthenticate, accountsUser } =
  await import('../../apps/api/src/middleware/auth');
const { configureAccountsVerifier, configureRevocationCheck, isAccountsToken } =
  await import('../../apps/api/src/lib/accounts-token');
const { config } = await import('../../apps/api/src/config');
const { invalidateAccountState, LIVE_IDENTITY_TTL_MS } =
  await import('../../apps/api/src/lib/identity-live-cache');

const ISS = 'https://accounts.ebda.app';
const keys = await generateKeyPair('ES256');
const other = await generateKeyPair('ES256');
const pub: JWK = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
let jwksFetches = 0;
let publishedKeys: JWK[] = [pub];
let revoked = new Set<string>();
let revocationDown = false;
let revocationError: string | undefined;

beforeEach(() => {
  rows.clear();
  rows.set('user-1', {
    id: 'user-1',
    role: 'store_admin',
    status: 'active',
    tokenVersion: 0,
    storeId: null,
    deletedAt: null,
  });
  jwksFetches = 0;
  publishedKeys = [pub];
  revoked = new Set();
  revocationDown = false;
  revocationError = undefined;
  configureAccountsVerifier(async () => {
    jwksFetches += 1;
    return { keys: publishedKeys };
  });
  configureRevocationCheck(async sid => {
    if (revocationError) throw new Error(revocationError);
    if (revocationDown) throw new Error('identity down');
    return revoked.has(sid);
  });
});

async function mint(
  over: {
    aud?: string;
    iss?: string;
    kid?: string;
    key?: CryptoKey;
    typ?: string;
    exp?: string | number;
    claims?: Record<string, unknown>;
    sub?: string;
  } = {}
) {
  return new SignJWT({
    sid: 'sid-1',
    stores: [{ id: 'store-1', role: 'owner' }],
    email: 'm@example.com',
    ...(over.claims ?? {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: over.kid ?? 'k1', typ: over.typ ?? 'at+jwt' })
    .setIssuer(over.iss ?? ISS)
    .setAudience(over.aud ?? 'store')
    .setSubject(over.sub ?? 'user-1')
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '15m')
    .setJti(crypto.randomUUID())
    .sign(over.key ?? keys.privateKey);
}

const reqWith = (
  token?: string,
  method = 'POST',
  originalUrl = '/api/v1/stores/store-1/orders'
): Request =>
  ({
    method,
    originalUrl,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cookies: {},
  }) as unknown as Request;

async function runWith(method: string, url: string, token: string) {
  const req = reqWith(token, method, url);
  const next = vi.fn();
  await authenticate(req, {} as Response, next as unknown as NextFunction);
  return { req, err: next.mock.calls[0]?.[0] as { statusCode?: number } | undefined };
}

async function run(fn: typeof authenticate, token?: string) {
  const req = reqWith(token);
  const next = vi.fn();
  await fn(req, {} as Response, next as unknown as NextFunction);
  const err = next.mock.calls[0]?.[0] as { statusCode?: number; code?: string } | undefined;
  return { req, err };
}

describe('platform admin (pa) needs a fresh login (Ruling ID-15)', () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const admin = (authTime?: number) =>
    mint({
      claims: { pa: 'super_admin', ...(authTime === undefined ? {} : { auth_time: authTime }) },
    });

  // ID-02: the claim alone is never enough, the account must STILL be a super_admin.
  beforeEach(() => {
    rows.get('user-1')!.role = 'super_admin';
  });

  it('ID-02: a pa token of an account demoted to store_admin is refused on the very next request', async () => {
    const t = await admin(nowS() - 60);
    expect((await run(authenticate, t)).err).toBeUndefined();
    rows.get('user-1')!.role = 'store_admin';
    const { req, err } = await run(authenticate, t);
    expect(err).toMatchObject({ statusCode: 401, code: 'TOKEN_REVOKED' });
    expect(req.user).toBeUndefined();
  });

  it('ID-02: the role is read LIVE even on a plain GET and is never served from the 30 s account cache', async () => {
    const t = await admin(nowS() - 60);
    // warm the shared cache with a NON-pa request for the same user (cacheable positive answer)
    await run(authenticate, await mint());
    rows.get('user-1')!.role = 'store_admin';
    // a path on the NON-sensitive GET allowlist: a merchant would skip the live check here, a platform admin must not
    const plainRead = await runWith('GET', '/api/v1/admin/stores/store-1/layout', t);
    expect(plainRead.err).toMatchObject({ statusCode: 401, code: 'TOKEN_REVOKED' });
  });

  it('a pa token whose login is at most 12 h old is a super_admin', async () => {
    const { req, err } = await run(authenticate, await admin(nowS() - 3600));
    expect(err).toBeUndefined();
    expect(req.user?.role).toBe('super_admin');
  });

  it('a pa token whose login is older than 12 h is 401 REAUTH_REQUIRED', async () => {
    const { req, err } = await run(authenticate, await admin(nowS() - 13 * 3600));
    expect(err).toMatchObject({ statusCode: 401, code: 'REAUTH_REQUIRED' });
    expect(req.user).toBeUndefined();
  });

  it('a pa token with no auth_time cannot prove freshness and is refused the same way', async () => {
    const { err } = await run(authenticate, await admin(undefined));
    expect(err).toMatchObject({ statusCode: 401, code: 'REAUTH_REQUIRED' });
  });

  it('only aud=store carries the platform role: a pa token for another product is refused', async () => {
    const t = await mint({ aud: 'whatsapp', claims: { pa: 'super_admin', auth_time: nowS() } });
    expect((await run(authenticate, t)).err?.statusCode).toBe(401);
  });

  it('a merchant token with an old auth_time is unaffected (the limit is for platform admins only)', async () => {
    const t = await mint({ claims: { auth_time: nowS() - 90 * 24 * 3600 } });
    const { req, err } = await run(authenticate, t);
    expect(err).toBeUndefined();
    expect(req.user?.role).toBe('store_admin');
  });
});

describe('authenticate: identity-service tokens', () => {
  it('accepts a valid ES256 aud=store token and builds the request identity', async () => {
    const { req, err } = await run(authenticate, await mint());
    expect(err).toBeUndefined();
    expect(req.user).toMatchObject({
      userId: 'user-1',
      email: 'm@example.com',
      role: 'store_admin',
      storeId: null,
    });
    expect((req as unknown as { accountsSid: string }).accountsSid).toBe('sid-1');
  });

  it.each([
    ['another product audience', { aud: 'whatsapp' }],
    ['a wrong issuer', { iss: 'https://evil.example' }],
    ['a token signed by another key', { key: other.privateKey }],
    ['a wrong typ (an id token / generic JWT)', { typ: 'JWT' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['an unknown kid', { kid: 'attacker' }],
  ])('rejects %s with 401', async (_n, over) => {
    const { err, req } = await run(authenticate, await mint(over as never));
    expect(err?.statusCode).toBe(401);
    expect(req.user).toBeUndefined();
  });

  it('does not treat HS256 or alg none as identity tokens; they go through the legacy verifier and fail there', async () => {
    const hs = jwt.sign({ sid: 'x' }, 'x'.repeat(40), {
      algorithm: 'HS256',
      issuer: ISS,
      audience: 'store',
    });
    expect(isAccountsToken(hs)).toBe(false);
    const { err } = await run(authenticate, hs);
    expect(err?.statusCode).toBe(401);
    const none = `${btoa(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).replace(/=/g, '')}.${btoa(JSON.stringify({ sub: 'u', sid: 's', iss: ISS, aud: 'store', exp: 9999999999 })).replace(/=/g, '')}.`;
    expect((await run(authenticate, none)).err?.statusCode).toBe(401);
  });

  it('refuses an ES256 header that claims another key family (alg confusion): HS256 signed with the public key', async () => {
    const sig = jwt.sign({ sid: 'x', sub: 'u' }, JSON.stringify(pub), {
      algorithm: 'HS256',
      issuer: ISS,
      audience: 'store',
    });
    expect((await run(authenticate, sig)).err?.statusCode).toBe(401);
  });

  it('a revoked session is 401 TOKEN_REVOKED on the very next request', async () => {
    const token = await mint();
    expect((await run(authenticate, token)).err).toBeUndefined();
    revoked.add('sid-1');
    const { err } = await run(authenticate, token);
    expect(err).toMatchObject({ statusCode: 401, code: 'TOKEN_REVOKED' });
  });

  it('an unreachable revocation service is a 503 outage, never an allow and never a 401 logout', async () => {
    revocationDown = true;
    const { err, req } = await run(authenticate, await mint());
    expect(err).toMatchObject({ statusCode: 503, code: 'IDENTITY_UNAVAILABLE' });
    expect(req.user).toBeUndefined();
  });

  it('QA-105: a thrown identity error is ALWAYS a 503, even when its message says the session expired (never text-matched into a 401)', async () => {
    for (const m of ['session expired', 'token invalid', 'D1_ERROR: session not found', 'boom']) {
      revocationError = m;
      const { err, req } = await run(authenticate, await mint());
      expect(err).toMatchObject({ statusCode: 503, code: 'IDENTITY_UNAVAILABLE' });
      expect(req.user).toBeUndefined();
    }
  });

  it('refuses a JWKS that carries a private member', async () => {
    configureAccountsVerifier(async () => ({ keys: [{ ...pub, d: 'secret' } as JWK] }));
    expect((await run(authenticate, await mint())).err?.statusCode).toBe(401);
  });
});

describe('the Store profile row is checked on every request (defence in depth for revocations the identity service missed)', () => {
  it('a deleted user: the very next request with the still-valid token is 401 and nothing re-creates the row', async () => {
    const token = await mint();
    expect((await run(authenticate, token)).err).toBeUndefined();
    rows.delete('user-1'); // hard-deleted in the Store
    invalidateAccountState('user-1'); // the Store path that deletes/changes an account drops the 30 s cache (FP-4)
    const { err, req } = await run(authenticate, token);
    expect(err).toMatchObject({ statusCode: 401, code: 'TOKEN_REVOKED' });
    expect(req.user).toBeUndefined();
    expect(rows.has('user-1')).toBe(false); // authenticate never creates a profile row
  });

  it('a soft-deleted user is 401', async () => {
    rows.get('user-1')!.deletedAt = new Date();
    expect((await run(authenticate, await mint())).err).toMatchObject({ statusCode: 401 });
  });

  it.each(['suspended', 'inactive'])('a %s user is 403 on the next request', async status => {
    const token = await mint();
    expect((await run(authenticate, token)).err).toBeUndefined();
    rows.get('user-1')!.status = status;
    invalidateAccountState('user-1'); // setAccountStatus does this on the isolate that suspends (FP-4)
    expect((await run(authenticate, token)).err).toMatchObject({
      statusCode: 403,
      code: 'ACCOUNT_SUSPENDED',
    });
  });

  it('optionalAuthenticate treats a suspended, deleted or unknown profile as a guest', async () => {
    rows.get('user-1')!.status = 'suspended';
    expect((await run(optionalAuthenticate, await mint())).req.user).toBeUndefined();
    rows.delete('user-1');
    expect((await run(optionalAuthenticate, await mint())).req.user).toBeUndefined();
  });

  it('an UNKNOWN user is blocked everywhere, including the session exchange (Ruling NZ-D2: never a default)', async () => {
    rows.delete('user-1');
    const { authenticateAccounts } = await import('../../apps/api/src/middleware/auth');
    await expect(authenticateAccounts(await mint())).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      authenticateAccounts(await mint(), { allowMissingProfile: true })
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('live vs claims-only identity (Ruling NZ-D2)', () => {
  it('an allowlisted read (NZ-D10) trusts the signed claims: no identity call, even for a session revoked a moment ago', async () => {
    revoked.add('sid-1');
    const res = await runWith('GET', '/api/v1/stores/store-1/typography', await mint());
    expect(res.err).toBeUndefined();
    expect(res.req.user?.userId).toBe('user-1');
  });
  it('an unclassified GET is live by default (NZ-D10): a revoked session reading products is refused', async () => {
    revoked.add('sid-1');
    expect(
      (await runWith('GET', '/api/v1/stores/store-1/products', await mint())).err?.statusCode
    ).toBe(401);
  });
  it('every state change is live: revoked, suspended and unknown are refused', async () => {
    revoked.add('sid-1');
    expect(
      (await runWith('POST', '/api/v1/stores/store-1/products', await mint())).err?.statusCode
    ).toBe(401);
    revoked.clear();
    rows.get('user-1')!.status = 'suspended';
    invalidateAccountState('user-1'); // setAccountStatus drops the 30 s account-state cache (FP-4)
    expect(
      (await runWith('PUT', '/api/v1/stores/store-1/settings', await mint())).err?.statusCode
    ).toBe(403);
    rows.delete('user-1');
    invalidateAccountState('user-1');
    expect(
      (await runWith('DELETE', '/api/v1/stores/store-1/products/p1', await mint())).err?.statusCode
    ).toBe(401);
  });
  it.each([
    '/api/v1/stores/store-1/customers',
    '/api/v1/stores/store-1/customers/export?format=csv',
    '/api/v1/stores/store-1/staff',
    '/api/v1/stores/store-1/billing/invoices',
    '/api/v1/stores/store-1/settings',
    '/api/v1/admin/stores',
    '/api/v1/stores/store-1/payouts',
  ])('the sensitive read %s is live', async path => {
    revoked.add('sid-1');
    expect((await runWith('GET', path, await mint())).err?.statusCode).toBe(401);
  });
  it('an unreachable identity service on a live check is a 503, never an allow', async () => {
    revocationDown = true;
    expect(
      (await runWith('POST', '/api/v1/stores/store-1/orders', await mint())).err?.statusCode
    ).toBe(503);
  });
  it('a removed staff member keeps no write access: the very next write is refused', async () => {
    rows.delete('user-1'); // identity deleted the account (staff removal revokes via the identity service in the same handler)
    expect(
      (await runWith('POST', '/api/v1/stores/store-1/orders', await mint())).err?.statusCode
    ).toBe(401);
  });
});

describe('JWKS caching and rotation', () => {
  it('caches the key set across requests', async () => {
    const t = await mint();
    await run(authenticate, t);
    await run(authenticate, t);
    expect(jwksFetches).toBe(1);
  });

  it('an unknown kid triggers exactly one refetch, and a rotated-in key then verifies', async () => {
    await run(authenticate, await mint()); // warm cache with k1
    const pub2: JWK = {
      ...(await exportJWK(other.publicKey)),
      kid: 'k2',
      alg: 'ES256',
      use: 'sig',
    };
    publishedKeys = [pub, pub2];
    const { err } = await run(authenticate, await mint({ kid: 'k2', key: other.privateKey }));
    expect(err).toBeUndefined();
    expect(jwksFetches).toBe(2);
  });

  it('a stream of junk kids cannot become a fetch storm', async () => {
    await run(authenticate, await mint());
    for (let i = 0; i < 20; i++) await run(authenticate, await mint({ kid: `junk-${i}` }));
    expect(jwksFetches).toBeLessThanOrEqual(2);
  });
});

describe('role mapping and optionalAuthenticate', () => {
  it('maps pa=super_admin, staff-only memberships, owners and not-yet-a-merchant', () => {
    const base = { sub: 'u', sid: 's', jti: 'j', exp: 1 };
    expect(accountsUser({ ...base, stores: [], pa: 'super_admin' }).role).toBe('super_admin');
    expect(accountsUser({ ...base, stores: [{ id: 'a', role: 'staff' }] }).role).toBe('staff');
    expect(
      accountsUser({
        ...base,
        stores: [
          { id: 'a', role: 'staff' },
          { id: 'b', role: 'owner' },
        ],
      }).role
    ).toBe('store_admin');
    expect(accountsUser({ ...base, stores: [] }).role).toBe('store_admin');
  });

  it('the Store profile role decides store_admin vs staff (a mixed owner+staff user), but never grants super_admin', () => {
    const base = { sub: 'u', sid: 's', jti: 'j', exp: 1 };
    const mixed = [
      { id: 'a', role: 'staff' as const },
      { id: 'b', role: 'owner' as const },
    ];
    expect(accountsUser({ ...base, stores: mixed }, 'staff').role).toBe('staff');
    expect(accountsUser({ ...base, stores: [] }, 'store_admin').role).toBe('store_admin');
    // a profile row that says super_admin does NOT elevate: only the token's pa claim can
    expect(accountsUser({ ...base, stores: mixed }, 'super_admin').role).toBe('store_admin');
    expect(accountsUser({ ...base, stores: [], pa: 'super_admin' }, 'staff').role).toBe(
      'super_admin'
    );
  });

  it('optionalAuthenticate continues as a guest for a bad, revoked or unconfirmable token, and identifies a good one', async () => {
    const good = await run(optionalAuthenticate, await mint());
    expect(good.req.user?.userId).toBe('user-1');
    revoked.add('sid-1');
    expect((await run(optionalAuthenticate, await mint())).req.user).toBeUndefined();
    revoked.clear();
    revocationDown = true;
    const down = await run(optionalAuthenticate, await mint());
    expect(down.req.user).toBeUndefined();
    expect(down.err).toBeUndefined(); // proceeds as guest, no error
  });

  it('a config sanity check: the legacy secret is not the identity key', () => {
    expect(config.jwtSecret).not.toContain('BEGIN');
  });
});

describe('integrator client tokens are never accepted by the Store (identity v1.3 mirror)', () => {
  const clientClaims = {
    sid: 'cli_abc',
    client: true,
    scope: 'messages:send',
    stores: [{ id: 'store-1', role: 'integration' }],
  };

  it('a real client token (aud=whatsapp) is refused: wrong audience', async () => {
    const t = await mint({ aud: 'whatsapp', sub: 'cli_abc', claims: clientClaims });
    const { req, err } = await run(authenticate, t);
    expect(err).toMatchObject({ statusCode: 401 });
    expect(req.user).toBeUndefined();
  });

  it('even if signed for aud=store (a mis-issued token), client:true is refused', async () => {
    const t = await mint({ sub: 'cli_abc', claims: clientClaims });
    const { req, err } = await run(authenticate, t);
    expect(err).toMatchObject({ statusCode: 401 });
    expect(req.user).toBeUndefined();
  });

  it('a person token that carries role "integration" or client:true is refused, never mapped to a Store role', async () => {
    for (const claims of [
      { stores: [{ id: 'store-1', role: 'integration' }] },
      { client: true },
      { client: false },
    ]) {
      const { req, err } = await run(authenticate, await mint({ claims }));
      expect(err).toMatchObject({ statusCode: 401 });
      expect(req.user).toBeUndefined();
    }
  });

  it('optionalAuthenticate also refuses it (no silent anonymous downgrade that keeps the principal)', async () => {
    const t = await mint({ sub: 'cli_abc', claims: clientClaims });
    const { req } = await run(optionalAuthenticate, t);
    expect(req.user).toBeUndefined();
  });
});

describe('account-state cache (BE:E-1, Ruling FP-4)', () => {
  it('a positive answer is reused inside the window: one identity lookup for two requests', async () => {
    const token = await mint();
    expect((await run(authenticate, token)).err).toBeUndefined();
    rows.get('user-1')!.status = 'suspended'; // changed elsewhere; no Store path invalidated it
    // documented residual: still served for up to LIVE_IDENTITY_TTL_MS
    expect((await run(authenticate, token)).err).toBeUndefined();
  });

  it('the residual closes at the TTL', async () => {
    vi.useFakeTimers();
    try {
      const token = await mint();
      expect((await run(authenticate, token)).err).toBeUndefined();
      rows.get('user-1')!.status = 'suspended';
      vi.advanceTimersByTime(LIVE_IDENTITY_TTL_MS + 1);
      expect((await run(authenticate, token)).err).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a NEGATIVE answer is never cached: a suspended account is re-asked, so reactivation bites at once', async () => {
    const token = await mint();
    rows.get('user-1')!.status = 'suspended';
    expect((await run(authenticate, token)).err).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    rows.get('user-1')!.status = 'active';
    expect((await run(authenticate, token)).err).toBeUndefined();
  });

  it('revocation is NOT cached: a revoked session is refused on the very next request', async () => {
    const token = await mint();
    expect((await run(authenticate, token)).err).toBeUndefined();
    revoked.add('sid-1');
    expect((await run(authenticate, token)).err).toMatchObject({ code: 'TOKEN_REVOKED' });
  });
});
