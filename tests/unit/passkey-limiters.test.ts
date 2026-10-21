/**
 * The passkey limiters are IP-only buckets (sign-in takes no email), /begin is generous, /finish counts
 * FAILURES only. Built with the test skip turned off, the only way a vitest run can see a 429.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPasskeyLimiter, passkeyLimiterKey } from '@api/middleware/security';

function appFor(kind: 'begin' | 'finish') {
  const a = express();
  a.set('trust proxy', true);
  a.use(express.json());
  a.post('/x', createPasskeyLimiter(kind, { skip: () => false }), (req, res) => {
    res.status(req.body?.ok ? 200 : 401).json({ ok: !!req.body?.ok });
  });
  return a;
}

describe('passkey limiters', () => {
  it('key ignores the body: there is no email to rotate', () => {
    const k = (email: string) => passkeyLimiterKey({ ip: '203.0.113.9', body: { email } } as never);
    expect(k('a@x.com')).toBe(k('b@x.com'));
  });

  it('finish: the 21st FAILED attempt from one IP is 429, other IPs are unaffected', async () => {
    const a = appFor('finish');
    for (let i = 0; i < 20; i++) {
      expect(
        (await request(a).post('/x').set('X-Forwarded-For', '198.51.100.7').send({})).status
      ).toBe(401);
    }
    const blocked = await request(a).post('/x').set('X-Forwarded-For', '198.51.100.7').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(
      (await request(a).post('/x').set('X-Forwarded-For', '198.51.100.8').send({})).status
    ).toBe(401);
  });

  it('finish: successful sign-ins do not eat the budget', async () => {
    const a = appFor('finish');
    for (let i = 0; i < 40; i++) {
      expect(
        (await request(a).post('/x').set('X-Forwarded-For', '198.51.100.20').send({ ok: true }))
          .status
      ).toBe(200);
    }
  });

  it('begin: 60 per 15 minutes per IP', async () => {
    const a = appFor('begin');
    for (let i = 0; i < 60; i++) {
      expect(
        (await request(a).post('/x').set('X-Forwarded-For', '198.51.100.30').send({ ok: true }))
          .status
      ).toBe(200);
    }
    expect(
      (await request(a).post('/x').set('X-Forwarded-For', '198.51.100.30').send({ ok: true }))
        .status
    ).toBe(429);
  });
});
