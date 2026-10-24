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

const { authenticate, optionalAuthenticate, accountsUser } =
  await import('../../apps/api/src/middleware/auth');
const { configureAccountsVerifier, configureRevocationCheck, isAccountsToken } =
  await import('../../apps/api/src/lib/accounts-token');
const { config } = await import('../../apps/api/src/config');

const ISS = 'https://accounts.ebda.app';
const keys = await generateKeyPair('ES256');
const other = await generateKeyPair('ES256');
const pub: JWK = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
let jwksFetches = 0;
let publishedKeys: JWK[] = [pub];
let revoked = new Set<string>();
let revocationDown = false;

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
  configureAccountsVerifier(async () => {
    jwksFetches += 1;
    return { keys: publishedKeys };
  });
  configureRevocationCheck(async sid => {
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

const reqWith = (token?: string): Request =>
  ({
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cookies: {},
  }) as unknown as Request;

async function run(fn: typeof authenticate, token?: string) {
  const req = reqWith(token);
  const next = vi.fn();
  await fn(req, {} as Response, next as unknown as NextFunction);
  const err = next.mock.calls[0]?.[0] as { statusCode?: number; code?: string } | undefined;
  return { req, err };
}

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

  it('only the session exchange may proceed without a profile row (it creates it from a live identity)', async () => {
    rows.delete('user-1');
    const { authenticateAccounts } = await import('../../apps/api/src/middleware/auth');
    await expect(authenticateAccounts(await mint())).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      authenticateAccounts(await mint(), { allowMissingProfile: true })
    ).resolves.toBeTruthy();
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
