/**
 * optionalAuthenticate hardening + rejectImpersonated (unit)
 *
 * From the 2026-09-02 adversarial audit:
 *
 * 1. `optionalAuthenticate` ran `jwt.verify` and nothing else, making it a
 *    strictly weaker second verifier on the same secret. Refresh tokens are
 *    minted with the same `ebda-app` audience, so a 1-year refresh token was
 *    accepted as an access identity, and tokens revoked via logout /
 *    logout-all / password-change were still honoured on all 5 of its routes.
 *
 * 2. `POST /admin/impersonate` mints a token carrying `impersonatedBy`, and the
 *    claim's own doc said downstream guards could reject it — but no guard read
 *    it, so an impersonation session could erase the impersonated user's
 *    account or change their credentials.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

const denied = new Set<string>();
let tokenVersion = 0;

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isJtiDenied: (jti: string) => Promise.resolve(denied.has(jti)),
    getUserTokenVersion: () => Promise.resolve(tokenVersion),
    setUserTokenVersion: () => Promise.resolve(),
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: { user: { findUnique: () => Promise.resolve({ tokenVersion }) } },
}));

const { optionalAuthenticate, rejectImpersonated } =
  await import('../../apps/api/src/middleware/auth');
const { config } = await import('../../apps/api/src/config');

function sign(payload: Record<string, unknown>, jti?: string): string {
  return jwt.sign(payload, config.jwtSecret, {
    algorithm: 'HS256',
    issuer: 'ebda-api',
    audience: 'ebda-app',
    expiresIn: '30m',
    ...(jti ? { jwtid: jti } : {}),
  });
}

function makeReq(token?: string): Request {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cookies: {},
  } as unknown as Request;
}

// A customer token carries the store it was issued for (F-01, Ruling S11-1).
const BASE = {
  userId: 'u-1',
  email: 'u@example.com',
  role: 'customer',
  tv: 0,
  storeId: 'store-1',
};

describe('optionalAuthenticate', () => {
  beforeEach(() => {
    denied.clear();
    tokenVersion = 0;
  });

  it('accepts a normal access token', async () => {
    const req = makeReq(sign(BASE));
    const next = vi.fn();
    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);
    expect(req.user?.userId).toBe('u-1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('REFUSES a refresh token used as an access token', async () => {
    // Refresh tokens carry the same ebda-app audience, so jwt.verify alone
    // accepts them — this is the guard that must reject.
    const req = makeReq(sign({ ...BASE, type: 'refresh' }));
    const next = vi.fn();
    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('REFUSES a token with a non-access purpose claim', async () => {
    const req = makeReq(sign({ ...BASE, purpose: 'mfa' }));
    const next = vi.fn();
    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);
    expect(req.user).toBeUndefined();
  });

  it('honours the JTI denylist, so logout actually revokes here too', async () => {
    denied.add('jti-revoked');
    const req = makeReq(sign(BASE, 'jti-revoked'));
    const next = vi.fn();
    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);
    expect(req.user).toBeUndefined();
  });

  it('honours tokenVersion bulk revocation (logout-all / password change)', async () => {
    tokenVersion = 5; // server bumped it; the token still carries tv: 0
    const req = makeReq(sign(BASE));
    const next = vi.fn();
    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);
    expect(req.user).toBeUndefined();
  });

  it('still continues as a guest when no token is present', async () => {
    const req = makeReq();
    const next = vi.fn();
    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('rejectImpersonated', () => {
  function makeRes() {
    return {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    } as unknown as Response & { statusCode: number; body: { error?: { code?: string } } };
  }

  it('blocks an impersonation session from an irreversible account action', () => {
    const req = { user: { ...BASE, impersonatedBy: 'super-1' } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn();
    rejectImpersonated(req, res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error?.code).toBe('IMPERSONATION_FORBIDDEN');
  });

  it('lets a genuine session through', () => {
    const req = { user: { ...BASE } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn();
    rejectImpersonated(req, res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });
});
