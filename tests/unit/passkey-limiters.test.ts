/**
 * The passkey limiters are IP-only buckets (sign-in takes no email), /begin is generous, /finish counts
 * FAILURES only. Built with the test skip turned off, the only way a vitest run can see a 429.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createPasskeyLimiter,
  createPasskeyStepUpLimiter,
  passkeyBeginLimiterKey,
  passkeyLimiterKey,
  passkeyStepUpLimiterKey,
} from '@api/middleware/security';

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

  describe('begin limiter (review M3): per store host + IP, 300 per 15 minutes', () => {
    const req = (origin: string | undefined, ip = '203.0.113.9') =>
      ({ ip, headers: { origin }, body: {} }) as never;

    it('the same IP gets a separate bucket per store host', () => {
      expect(passkeyBeginLimiterKey(req('https://a.ebda.app'))).not.toBe(
        passkeyBeginLimiterKey(req('https://b.ebda.app'))
      );
      expect(passkeyBeginLimiterKey(req('https://a.ebda.app', '198.51.100.1'))).not.toBe(
        passkeyBeginLimiterKey(req('https://a.ebda.app', '198.51.100.2'))
      );
      expect(passkeyBeginLimiterKey(req('https://a.ebda.app'))).toBe(
        passkeyBeginLimiterKey(req('https://a.ebda.app'))
      );
    });

    it('a missing or junk Origin does not break the key or open a new bucket per value length', () => {
      expect(passkeyBeginLimiterKey(req(undefined))).toBe(passkeyBeginLimiterKey(req('not a url')));
      expect(passkeyBeginLimiterKey(req('x'.repeat(5000))).length).toBeLessThan(200);
    });

    it('301st request from one IP to one store host is 429; another store host is untouched', async () => {
      const a = express();
      a.set('trust proxy', true);
      a.post(
        '/x',
        createPasskeyLimiter('begin', { skip: () => false }),
        (_q, r) => void r.json({})
      );
      const hit = (origin: string) =>
        request(a).post('/x').set('X-Forwarded-For', '198.51.100.30').set('Origin', origin);
      for (let i = 0; i < 300; i++) expect((await hit('https://a.ebda.app')).status).toBe(200);
      expect((await hit('https://a.ebda.app')).status).toBe(429);
      expect((await hit('https://b.ebda.app')).status).toBe(200);
    });
  });

  describe('step-up limiter (review M2): keyed on the authenticated user, never on a body field', () => {
    const req = (userId: string | undefined, email: string, ip = '203.0.113.9') =>
      ({ ip, user: userId ? { userId } : undefined, body: { email } }) as never;

    it('a random body email buys no fresh bucket; another user has their own', () => {
      expect(passkeyStepUpLimiterKey(req('u1', 'a@x.com'))).toBe(
        passkeyStepUpLimiterKey(req('u1', 'b@x.com'))
      );
      expect(passkeyStepUpLimiterKey(req('u1', 'a@x.com'))).not.toBe(
        passkeyStepUpLimiterKey(req('u2', 'a@x.com'))
      );
    });

    it('moving IP does not reset a user\u2019s budget either', () => {
      expect(passkeyStepUpLimiterKey(req('u1', 'a', '198.51.100.1'))).toBe(
        passkeyStepUpLimiterKey(req('u1', 'a', '198.51.100.2'))
      );
    });

    it('the 11th attempt in a window is 429 even with a different email in every body', async () => {
      const a = express();
      a.use(express.json());
      a.post(
        '/x',
        (q: any, _r, n) => {
          q.user = { userId: 'u-limited' };
          n();
        },
        createPasskeyStepUpLimiter({ skip: () => false }),
        (_q, r) => void r.status(401).json({})
      );
      for (let i = 0; i < 10; i++) {
        expect(
          (
            await request(a)
              .post('/x')
              .send({ email: `r${i}@x.com` })
          ).status
        ).toBe(401);
      }
      expect((await request(a).post('/x').send({ email: 'fresh@x.com' })).status).toBe(429);
    });
  });
});
