/**
 * Ruling NZ-ACCT-1 (builds on NZ-N9-1): TOTP is not ported to the StoreDO, so every customer MFA endpoint answers the
 * MFA_UNAVAILABLE refusal for a store whose auth runs on its DO, BEFORE any Postgres `withUser`. It only refuses: no
 * path enrols, verifies or disables a second factor. A merchant (no store) keeps the Postgres handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  user: { userId: 'u1', role: 'customer', storeId: 'store-1' } as Record<string, unknown>,
  route: { kind: 'do' } as { kind: 'do' | 'pg' },
  withUser: vi.fn(),
  removed: false,
}));

vi.mock('@ebda/database', () => ({
  withUser: (...a: unknown[]) => h.withUser(...a),
}));
vi.mock('@api/middleware/auth', () => {
  const pass = (_q: unknown, _r: unknown, next: () => void) => next();
  return {
    authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = h.user;
      next();
    },
    rejectAdminOnMerchantOrigin: pass,
    rejectIdentityManaged: pass,
    rejectImpersonated: pass,
  };
});
vi.mock('@api/middleware/security', () => {
  const pass = (_q: unknown, _r: unknown, next: () => void) => next();
  return { authLimiter: pass, authIpFailureLimiter: pass };
});
vi.mock('@api/lib/customer-auth', () => ({ customerAuthRoute: async () => h.route }));
vi.mock('@api/lib/postgres-present', () => ({ postgresRemovedOnThisWorker: () => h.removed }));
vi.mock('@api/services/mfa.service', () => ({ MfaService: {} }));
vi.mock('@api/services/encryption.service', () => ({ encryption: {} }));
vi.mock('@api/services/auth.service', () => ({ AuthService: {} }));
vi.mock('@api/routes/auth.routes', () => ({ setSessionCookies: vi.fn() }));
vi.mock('@api/services/redis.service', () => ({ redis: { getMfaAttempts: async () => 0 } }));
vi.mock('@api/config', () => ({ config: { jwtSecret: 'unit-test-secret' } }));

import jwt from 'jsonwebtoken';
import mfaRoutes from '@api/routes/mfa.routes';
import { errorHandler } from '@api/middleware/error-handler';

const app = express();
app.use(express.json());
app.use('/auth/mfa', mfaRoutes);
app.use(errorHandler as never);

beforeEach(() => {
  h.user = { userId: 'u1', role: 'customer', storeId: 'store-1' };
  h.route = { kind: 'do' };
  h.removed = false;
  h.withUser.mockReset();
  h.withUser.mockRejectedValue(new Error('withUser must not be reached'));
});

describe('customer MFA on a DO store', () => {
  it.each([
    ['/auth/mfa/enroll/begin', {}],
    ['/auth/mfa/enroll/verify', { code: '123456' }],
    ['/auth/mfa/disable', { code: '123456' }],
  ])('%s answers 409 MFA_UNAVAILABLE and never reaches withUser', async (path, body) => {
    const res = await request(app).post(path).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MFA_UNAVAILABLE');
    expect(h.withUser).not.toHaveBeenCalled();
  });

  it('a bad body still fails validation, not the refusal order (no oracle either way)', async () => {
    const res = await request(app).post('/auth/mfa/disable').send({ code: 'x' });
    // the refusal comes first: a DO customer learns nothing about code validity
    expect(res.status).toBe(409);
  });

  it('a customer of a Postgres store keeps the Postgres handler', async () => {
    h.route = { kind: 'pg' };
    const res = await request(app).post('/auth/mfa/disable').send({ code: '123456' });
    expect(h.withUser).toHaveBeenCalled();
    expect(res.body.error?.code).not.toBe('MFA_UNAVAILABLE');
  });

  it('a merchant (not a customer) is never routed to the DO', async () => {
    h.user = { userId: 'm1', role: 'store_admin', storeId: 'store-1' };
    const res = await request(app).post('/auth/mfa/disable').send({ code: '123456' });
    expect(h.withUser).toHaveBeenCalled();
    expect(res.body.error?.code).not.toBe('MFA_UNAVAILABLE');
  });

  it('/verify with a valid challenge on a Postgres-less Worker refuses, and does not reach withUser', async () => {
    h.removed = true;
    const challengeToken = jwt.sign(
      { userId: 'u1', purpose: 'mfa', jti: 'j1' },
      'unit-test-secret',
      {
        algorithm: 'HS256',
        issuer: 'ebda-api',
        audience: 'ebda-mfa-challenge',
        expiresIn: '5m',
      }
    );
    const res = await request(app)
      .post('/auth/mfa/verify')
      .send({ challengeToken, code: '123456' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MFA_UNAVAILABLE');
    expect(h.withUser).not.toHaveBeenCalled();
  });

  it('/verify with a bad challenge is still a 401, not the refusal', async () => {
    h.removed = true;
    const res = await request(app)
      .post('/auth/mfa/verify')
      .send({ challengeToken: 'not-a-jwt', code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_CHALLENGE_INVALID');
  });
});
