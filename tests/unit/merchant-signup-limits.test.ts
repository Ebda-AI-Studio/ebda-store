/**
 * SP5 task 2 - abuse bounds on the public merchant signup routes.
 *
 * Every shared limiter is disabled under vitest (`skipForLoadTestOrTests`), so
 * driving the route can never observe a 429. These tests build the limiter
 * from its factory with the skip turned OFF and drive a real express app, and
 * pin the key function directly.
 *
 * Mutation proof (recorded in the commit body): change
 * `merchantSignupIpLimiterKey` to include `req.body.email` -> "rotating the
 * email does not mint a fresh bucket" fails (every request gets its own bucket).
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import {
  createMerchantSignupIpLimiter,
  merchantSignupIpLimiterKey,
  isCsrfExemptAuthPath,
} from '@api/middleware/security';

function appWithLimit(max: number) {
  const app = express();
  app.use(express.json());
  app.post(
    '/signup',
    createMerchantSignupIpLimiter({
      skip: () => false,
      max,
      prefix: `test-signup-${crypto.randomUUID()}`,
    }),
    (_req, res) => {
      res.json({ ok: true });
    }
  );
  return app;
}

describe('merchant signup per-IP limiter', () => {
  it('429s the request after the budget, with the stable RATE_LIMITED code', async () => {
    const app = appWithLimit(3);
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await request(app)
            .post('/signup')
            .send({ email: `a${i}@x.com` })
        ).status
      ).toBe(200);
    }
    const blocked = await request(app).post('/signup').send({ email: 'a9@x.com' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('rotating the email does not mint a fresh bucket (IP-only key)', async () => {
    const app = appWithLimit(2);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (
          await request(app)
            .post('/signup')
            .send({ email: `rot${i}@x.com` })
        ).status
      );
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it('key is IP-scoped and ignores the body', () => {
    const req = (ip: string, email: string) =>
      ({ ip, body: { email } }) as unknown as Parameters<typeof merchantSignupIpLimiterKey>[0];
    expect(merchantSignupIpLimiterKey(req('1.2.3.4', 'a@x.com'))).toBe(
      merchantSignupIpLimiterKey(req('1.2.3.4', 'b@x.com'))
    );
    expect(merchantSignupIpLimiterKey(req('1.2.3.4', 'a@x.com'))).not.toBe(
      merchantSignupIpLimiterKey(req('5.6.7.8', 'a@x.com'))
    );
  });
});

describe('merchant signup CSRF posture', () => {
  it('only the two credential-less entry points are exempt', () => {
    expect(isCsrfExemptAuthPath('/api/v1/auth/merchant/signup')).toBe(true);
    expect(isCsrfExemptAuthPath('/api/v1/auth/merchant/resend-verification')).toBe(true);
    // Everything authenticated stays CSRF-checked.
    expect(isCsrfExemptAuthPath('/api/v1/onboarding/store')).toBe(false);
    expect(isCsrfExemptAuthPath('/api/v1/onboarding/stores/x/go-live')).toBe(false);
    expect(isCsrfExemptAuthPath('/api/v1/auth/merchant/other')).toBe(false);
  });
});
