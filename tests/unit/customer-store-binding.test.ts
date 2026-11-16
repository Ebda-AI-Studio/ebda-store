/**
 * F-01 / Ruling S11-1 — a customer identity is bound to ONE store.
 *
 * The auth cookie is SameSite=None on the API host and CORS is credentialed for every
 * live store origin, so a page on store B's verified domain could ride a signed-in
 * customer of store A and read their data. The binding lives in `authenticate` /
 * `optionalAuthenticate` (one place, every customer route): the token's `storeId` must
 * equal the store named by `X-Store-ID`/`x-store-domain` AND the store that owns the
 * request's Origin. A header alone is not enough — the attacker sends A's id — which is
 * why the Origin case below is the one that proves the fix.
 *
 * Merchant/staff/super_admin tokens are not store-bound, so from a STORE origin they are no
 * identity at all (#622 / Ruling CORS-TB-1: credentialed cross-origin = same-tenant only);
 * from a platform origin or with no Origin they are untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { ORIGINAL_ROOT } from '../helpers/original-repo-root';

const SLUG_TO_STORE: Record<string, string> = { 'shop-a': 'store-a', 'shop-b': 'store-b' };
const DOMAIN_TO_STORE: Record<string, string> = { 'shop-a.com': 'store-a' };

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isJtiDenied: () => Promise.resolve(false),
    getUserTokenVersion: () => Promise.resolve(0),
    setUserTokenVersion: () => Promise.resolve(),
  },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  getUserState: async () => ({ tokenVersion: 0, status: 'active' }),
  resolveStoreId: async (m: { slug?: string; domain?: string }) =>
    (m.slug ? SLUG_TO_STORE[m.slug] : m.domain ? DOMAIN_TO_STORE[m.domain] : undefined) ?? null,
  lookupStore: async () => null,
}));
vi.mock('../../apps/api/src/utils/store-helpers', () => ({
  // The real helper validates the header against the DB; here the ids are the stores.
  resolvePublicStoreId: async (req: Request) => {
    const h = req.headers['x-store-id'] as string | undefined;
    return h === 'store-a' || h === 'store-b' ? h : undefined;
  },
  getAuthUser: (req: Request) => req.user,
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));

const { authenticate, optionalAuthenticate } = await import('../../apps/api/src/middleware/auth');
const { clearOriginStoreCache } = await import('../../apps/api/src/lib/customer-store-binding');
const { config } = await import('../../apps/api/src/config');

function sign(payload: Record<string, unknown>): string {
  return jwt.sign({ email: 'u@example.test', tv: 0, ...payload }, config.jwtSecret, {
    algorithm: 'HS256',
    issuer: 'ebda-api',
    audience: 'ebda-app',
    expiresIn: '30m',
  });
}

function makeReq(token: string, headers: Record<string, string> = {}): Request {
  return {
    headers: { authorization: `Bearer ${token}`, ...headers },
    cookies: {},
  } as unknown as Request;
}

async function runAuthenticate(req: Request): Promise<Error | undefined> {
  let err: Error | undefined;
  await authenticate(
    req,
    {} as Response,
    ((e?: Error) => {
      err = e;
    }) as NextFunction
  );
  return err;
}

const customerA = () => sign({ userId: 'cust-1', role: 'customer', storeId: 'store-a' });
const PLATFORM_ORIGIN = 'https://store.ebda.app';

beforeEach(() => clearOriginStoreCache());

describe('authenticate: customer token ↔ request store', () => {
  // [label, headers, expected accepted]
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ['token A + X-Store-ID A', { 'x-store-id': 'store-a' }, true],
    ['token A + X-Store-ID B', { 'x-store-id': 'store-b' }, false],
    ['token A, no store headers, no Origin (non-browser holder of its own token)', {}, true],
    ['token A + Origin of store A (slug host)', { origin: 'https://shop-a.ebda.app' }, true],
    [
      'token A + Origin of store A (verified custom domain)',
      { origin: 'https://shop-a.com' },
      true,
    ],
    [
      'token A + Origin of store A + X-Store-ID A',
      { origin: 'https://shop-a.ebda.app', 'x-store-id': 'store-a' },
      true,
    ],
    // THE ATTACK: a page on store B's domain sends A's id so the header "matches".
    [
      'token A + Origin of store B + X-Store-ID A (header spoofed to match)',
      { origin: 'https://shop-b.ebda.app', 'x-store-id': 'store-a' },
      false,
    ],
    ['token A + Origin of store B, no header', { origin: 'https://shop-b.ebda.app' }, false],
    [
      'token A + Origin of store A + X-Store-ID B',
      { origin: 'https://shop-a.ebda.app', 'x-store-id': 'store-b' },
      false,
    ],
    ['token A + an origin that owns no store', { origin: 'https://evil.example' }, false],
    ['token A + Origin: null (sandboxed iframe)', { origin: 'null' }, false],
    [
      'token A + platform origin + X-Store-ID A (previews/dev)',
      { origin: PLATFORM_ORIGIN, 'x-store-id': 'store-a' },
      true,
    ],
    [
      'token A + platform origin + X-Store-ID B',
      { origin: PLATFORM_ORIGIN, 'x-store-id': 'store-b' },
      false,
    ],
  ];

  it.each(cases)('%s', async (_label, headers, accepted) => {
    const req = makeReq(customerA(), headers);
    const err = await runAuthenticate(req);
    if (accepted) {
      expect(err).toBeUndefined();
      expect(req.user?.userId).toBe('cust-1');
    } else {
      expect(err).toMatchObject({ statusCode: 401 });
      expect(req.user).toBeUndefined();
    }
  });

  it('rejects a legacy customer token with no storeId claim (it re-mints on silent refresh)', async () => {
    const req = makeReq(sign({ userId: 'cust-1', role: 'customer' }), { 'x-store-id': 'store-a' });
    expect(await runAuthenticate(req)).toMatchObject({ statusCode: 401 });
  });

  it('rejects a customer token whose storeId is null or empty', async () => {
    for (const storeId of [null, '']) {
      const req = makeReq(sign({ userId: 'cust-1', role: 'customer', storeId }), {
        'x-store-id': 'store-a',
      });
      expect(await runAuthenticate(req)).toMatchObject({ statusCode: 401 });
    }
  });

  it('answers a mismatch exactly like a dead token (no oracle)', async () => {
    const mismatch = await runAuthenticate(makeReq(customerA(), { 'x-store-id': 'store-b' }));
    const dead = await runAuthenticate(makeReq('not-a-jwt'));
    expect(mismatch).toMatchObject({ statusCode: 401, code: 'TOKEN_INVALID' });
    expect(dead).toMatchObject({ statusCode: 401, code: 'TOKEN_INVALID' });
    expect((mismatch as Error).message).toBe((dead as Error).message);
  });

  it.each(['store_admin', 'staff', 'super_admin'])(
    'a %s token works from a platform origin or with no Origin (any X-Store-ID, with or without storeId)',
    async role => {
      for (const storeId of [undefined, 'store-a', null]) {
        for (const origin of [PLATFORM_ORIGIN, undefined]) {
          const req = makeReq(sign({ userId: 'u-9', role, storeId }), {
            ...(origin ? { origin } : {}),
            'x-store-id': 'store-b',
          });
          expect(await runAuthenticate(req)).toBeUndefined();
          expect(req.user?.role).toBe(role);
        }
      }
    }
  );

  // #622: merchant A verifies a domain and lures store B's owner (or a super_admin). The
  // browser sends B's cookie; it must not become an identity on ANY route.
  it.each(['store_admin', 'staff', 'super_admin'])(
    'a %s token from a STORE origin is refused, even its own store (#622)',
    async role => {
      for (const origin of [
        'https://shop-a.com', // store A's verified custom domain
        'https://shop-a.ebda.app', // store subdomain
        'https://shop-b.ebda.app', // the token's own store: still not an admin surface
        'https://evil.example',
        'null',
      ]) {
        const req = makeReq(sign({ userId: 'u-9', role, storeId: 'store-b' }), {
          origin,
          'x-store-id': 'store-b',
        });
        expect(await runAuthenticate(req), `${role} @ ${origin}`).toMatchObject({
          statusCode: 401,
          code: 'TOKEN_INVALID',
        });
        expect(req.user).toBeUndefined();
      }
    }
  );

  it('an impersonation token for a merchant is refused from a store origin (#622)', async () => {
    const req = makeReq(
      sign({ userId: 'u-9', role: 'store_admin', storeId: null, impersonatedBy: 'sa-1' }),
      { origin: 'https://shop-a.com' }
    );
    expect(await runAuthenticate(req)).toMatchObject({ statusCode: 401 });
  });

  it("store A's custom domain + store B shopper token is refused (#622 exploit)", async () => {
    const req = makeReq(sign({ userId: 'cust-2', role: 'customer', storeId: 'store-b' }), {
      origin: 'https://shop-a.com',
      'x-store-id': 'store-b',
    });
    expect(await runAuthenticate(req)).toMatchObject({ statusCode: 401 });
    expect(req.user).toBeUndefined();
  });
});

describe('optionalAuthenticate: a mismatched customer token is a guest', () => {
  it.each(cases2())('%s', async (_label, headers, identified) => {
    const req = makeReq(customerA(), headers);
    const next = vi.fn();
    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(Boolean(req.user)).toBe(identified);
  });

  it('a legacy token without storeId is a guest', async () => {
    const req = makeReq(sign({ userId: 'cust-1', role: 'customer' }), { 'x-store-id': 'store-a' });
    await optionalAuthenticate(req, {} as Response, vi.fn() as unknown as NextFunction);
    expect(req.user).toBeUndefined();
  });

  it('an admin token keeps its identity from a platform origin regardless of store headers', async () => {
    const req = makeReq(sign({ userId: 'a-1', role: 'store_admin' }), {
      origin: PLATFORM_ORIGIN,
      'x-store-id': 'store-b',
    });
    await optionalAuthenticate(req, {} as Response, vi.fn() as unknown as NextFunction);
    expect(req.user?.userId).toBe('a-1');
  });

  it('an admin token from a store origin is a guest (#622)', async () => {
    const req = makeReq(sign({ userId: 'a-1', role: 'store_admin' }), {
      origin: 'https://shop-a.com',
    });
    const next = vi.fn();
    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
  });
});

function cases2(): Array<[string, Record<string, string>, boolean]> {
  return [
    ['token A + X-Store-ID A is identified', { 'x-store-id': 'store-a' }, true],
    ['token A + X-Store-ID B is a guest', { 'x-store-id': 'store-b' }, false],
    [
      'token A + Origin B + spoofed X-Store-ID A is a guest',
      { origin: 'https://shop-b.ebda.app', 'x-store-id': 'store-a' },
      false,
    ],
    ['token A + Origin A is identified', { origin: 'https://shop-a.ebda.app' }, true],
    ['token A + custom domain of A is identified', { origin: 'https://shop-a.com' }, true],
  ];
}

describe('coverage: the binding cannot be forgotten by a customer route', () => {
  const apiSrc = path.resolve(ORIGINAL_ROOT, 'apps/api/src');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) {
        if (e !== '__tests__' && e !== 'node_modules') walk(p, out);
      } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
    }
    return out;
  };
  const files = walk(apiSrc);
  const rel = (p: string) => path.relative(apiSrc, p);

  it('only the known token readers call jwt.verify on an access token', () => {
    // Anything else that verifies a customer-capable access token would bypass the binding.
    const allowed = new Set([
      'middleware/auth.ts', // authenticate / optionalAuthenticate: the bound verifiers
      'middleware/security.ts', // csrfPrincipal (identity string only) + refresh limiter key
      'routes/auth.routes.ts', // refresh rotation, logout denylist, csrf mint role check
      'routes/mfa.routes.ts', // MFA challenge token (purpose token, not an access token)
      'routes/passkey.routes.ts', // reads the jti of the access token it minted one line earlier (step-up window)
      'lib/staff-invite-token.ts', // staff-invitation purpose token (own audience), not an access token
      'services/socket.service.ts', // websocket: platform origins only, no customer rooms
    ]);
    const offenders = files
      .filter(f => /jwt\.verify\(/.test(readFileSync(f, 'utf-8')))
      .map(rel)
      .filter(f => !allowed.has(f));
    expect(offenders).toEqual([]);
  });

  it('every route file that reads a customer identity gets it from authenticate/optionalAuthenticate', () => {
    const readers = files.filter(
      f => rel(f).startsWith('routes/') && /customerUserId\(/.test(readFileSync(f, 'utf-8'))
    );
    expect(readers.length).toBeGreaterThan(5);
    for (const f of readers) {
      const src = readFileSync(f, 'utf-8');
      expect(
        /\b(authenticate|optionalAuthenticate)\b/.test(src),
        `${rel(f)} reads customerUserId but never mounts authenticate/optionalAuthenticate`
      ).toBe(true);
    }
  });

  it('authenticate and optionalAuthenticate both enforce the binding for customer tokens', () => {
    const src = readFileSync(path.join(apiSrc, 'middleware/auth.ts'), 'utf-8');
    expect(src.match(/customerTokenMatchesRequestStore\(/g)?.length).toBe(2);
  });

  it('both verifiers refuse non-customer tokens from store origins on BOTH token kinds (#622)', () => {
    const src = readFileSync(path.join(apiSrc, 'middleware/auth.ts'), 'utf-8');
    // accounts (ES256) branch + HS256 branch, in authenticate and optionalAuthenticate.
    expect(src.match(/nonCustomerTokenAllowedForRequest\(req\)/g)?.length).toBe(4);
  });

  it('token mints stamp the store id (login, refresh and MFA all go through generateTokens)', () => {
    const src = readFileSync(path.join(apiSrc, 'services/auth.service.ts'), 'utf-8');
    const calls = [...src.matchAll(/this\.generateTokens\(\s*\{[\s\S]{0,260}?\}/g)].map(m => m[0]);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/storeId:\s*[\w.]*storeId/);
  });
});
