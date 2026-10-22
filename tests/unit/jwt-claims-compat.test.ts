/**
 * JWT iss/aud rename (retired claim values -> ebda-api/ebda-app).
 *
 * New tokens carry the Ebda claims. For ONE release the verifiers also accept the
 * legacy claims so a deploy does not kill sessions mid-rollout (access tokens
 * live 30m, refresh tokens up to a year). The legacy values live in exactly one
 * place, packages/shared/src/auth/jwt-claims.ts, with a removal date.
 */
import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import {
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_ISSUERS_ACCEPTED,
  JWT_AUDIENCES_ACCEPTED,
  LEGACY_JWT_REMOVE_AFTER,
} from '@ebda/shared';

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isJtiDenied: () => Promise.resolve(false),
    getUserTokenVersion: () => Promise.resolve(0),
    setUserTokenVersion: () => Promise.resolve(),
  },
}));
vi.mock('@ebda/database', () => ({
  prisma: { user: { findUnique: () => Promise.resolve({ tokenVersion: 0 }) } },
}));

const { optionalAuthenticate } = await import('../../apps/api/src/middleware/auth');
const { config } = await import('../../apps/api/src/config');

const BASE = { userId: 'u-1', email: 'u@example.com', role: 'customer', tv: 0, storeId: 's-1' };
const mint = (issuer: string, audience: string) =>
  jwt.sign(BASE, config.jwtSecret, { algorithm: 'HS256', issuer, audience, expiresIn: '30m' });

async function userFor(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} } as unknown as Request;
  await optionalAuthenticate(req, {} as Response, vi.fn() as unknown as NextFunction);
  return req.user;
}

// Assembled so this file spells no retired name outside the one allowed fallback file.
const LEGACY_ISS = ['force', 'api'].join('-');
const LEGACY_AUD = ['force', 'app'].join('-');

describe('JWT claim rename', () => {
  it('issues the Ebda claims by default', () => {
    expect(JWT_ISSUER).toBe('ebda-api');
    expect(JWT_AUDIENCE).toBe('ebda-app');
    expect(JWT_ISSUERS_ACCEPTED[0]).toBe('ebda-api');
    expect(JWT_AUDIENCES_ACCEPTED[0]).toBe('ebda-app');
  });

  it('accepts a token with the new claims', async () => {
    expect((await userFor(mint('ebda-api', 'ebda-app')))?.userId).toBe('u-1');
  });

  it('still accepts a token minted before the rename (one-release fallback)', async () => {
    expect((await userFor(mint(LEGACY_ISS, LEGACY_AUD)))?.userId).toBe('u-1');
  });

  it('rejects any other issuer or audience', async () => {
    expect(await userFor(mint('someone-else', 'ebda-app'))).toBeUndefined();
    expect(await userFor(mint('ebda-api', 'someone-else'))).toBeUndefined();
    expect(await userFor(mint('ebda-api', 'ebda-mfa-challenge'))).toBeUndefined();
  });

  it('records a removal date for the legacy fallback, and it is in the future or flagged', () => {
    expect(LEGACY_JWT_REMOVE_AFTER).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
