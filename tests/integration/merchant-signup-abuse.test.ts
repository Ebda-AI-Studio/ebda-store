/**
 * SP5 task 4 - signup spam controls: honeypot, signed form token + minimum
 * fill time, disposable-domain block, per-email-domain daily cap, and the
 * per-IP / per-/24 velocity limiters. Allowed vs blocked for each.
 *
 * Lives in tests/integration: the one-use token claim and per-domain counter need Redis (CI's
 * integration job has it; the unit job does not).
 *
 * The shared limiters are skipped under vitest, so velocity is driven through
 * the limiter factories with the skip turned off (same approach as
 * merchant-signup-limits.test.ts); the gate runs through the real route.
 *
 * Mutation proofs (recorded in the commit body):
 *   1. signup-abuse.service.ts: delete the `isDisposableEmail` refusal ->
 *      "refuses a disposable domain" fails (200).
 *   2. middleware/security.ts `signupSubnetKey`: return the full IP instead of
 *      the /24 -> "a different host in the same /24 shares the budget" fails.
 *   3. signup-abuse.service.ts: drop the `age < signupMinFillMs` check ->
 *      "refuses a submit faster than the minimum fill time" fails.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

const { signupMock } = vi.hoisted(() => ({ signupMock: vi.fn() }));

vi.mock('@api/services/merchant-signup.service', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/services/merchant-signup.service')>();
  return { ...actual, MerchantSignupService: { signup: signupMock, resendVerification: vi.fn() } };
});
vi.mock('@api/middleware/security', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/security')>();
  return { ...actual, auditLog: vi.fn().mockResolvedValue(undefined) };
});

import merchantSignupRoutes from '@api/routes/merchant-signup.routes';
import {
  createSignupIpVelocityLimiter,
  createSignupSubnetVelocityLimiter,
  signupSubnetKey,
} from '@api/middleware/security';
import { errorHandler } from '@api/middleware/error-handler';
import { issueSignupFormToken, verifySignupFormToken } from '@api/services/signup-abuse.service';
import { redis } from '@api/services/redis.service';

const PASSWORD = 'Str0ng!Passw0rd';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/auth/merchant', merchantSignupRoutes);
  a.use(errorHandler);
  return a;
}

/** A token the server would have issued `ageMs` ago. */
function tokenAged(ageMs: number) {
  return issueSignupFormToken(Date.now() - ageMs);
}

let seq = 0;
/** A unique non-major domain per call, so the Redis day-counter never leaks between tests. */
const freshDomain = () => `corp-${crypto.randomUUID().slice(0, 8)}-${seq++}.example.org`;

function body(email: string, extra: Record<string, unknown> = {}) {
  return {
    email,
    password: PASSWORD,
    name: 'Mona Hassan',
    phone: '01012345678',
    formToken: tokenAged(10_000),
    acceptedLegal: true,
    ...extra,
  };
}

// The one-use token claim and the per-domain counter live in Redis (REDIS_URL).
beforeAll(async () => {
  await redis.connect();
  expect(redis.isAvailable()).toBe(true);
});
afterAll(async () => {
  await redis.disconnect();
});

beforeEach(() => {
  signupMock.mockReset();
  signupMock.mockResolvedValue({ emailVerificationSent: true });
  delete process.env.SIGNUP_MIN_FILL_MS;
  delete process.env.SIGNUP_EMAIL_DOMAIN_DAILY_CAP;
});
afterEach(() => {
  delete process.env.SIGNUP_MIN_FILL_MS;
  delete process.env.SIGNUP_EMAIL_DOMAIN_DAILY_CAP;
});

describe('signup gate (route)', () => {
  it('lets a well-formed, patient signup through', async () => {
    const res = await request(app())
      .post('/auth/merchant/signup')
      .send(body(`a@${freshDomain()}`));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ emailVerificationSent: true });
    expect(signupMock).toHaveBeenCalledTimes(1);
  });

  it('honeypot: a filled hidden field gets the SAME generic success and creates nothing', async () => {
    const ok = await request(app())
      .post('/auth/merchant/signup')
      .send(body(`a@${freshDomain()}`));
    signupMock.mockClear();
    const bot = await request(app())
      .post('/auth/merchant/signup')
      .send(body(`b@${freshDomain()}`, { company_site: 'http://spam.example' }));
    expect(bot.status).toBe(200);
    expect(bot.body).toEqual(ok.body); // indistinguishable
    expect(signupMock).not.toHaveBeenCalled();
  });

  it('refuses a submit faster than the minimum fill time', async () => {
    const res = await request(app())
      .post('/auth/merchant/signup')
      .send(body(`a@${freshDomain()}`, { formToken: tokenAged(200) }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNUP_TOO_FAST');
    expect(signupMock).not.toHaveBeenCalled();
  });

  it('two tokens issued in the same millisecond are distinct and each verifies (FU46-11)', () => {
    const at = Date.now() - 10_000;
    const a = issueSignupFormToken(at);
    const b = issueSignupFormToken(at);
    expect(a).not.toBe(b);
    expect(verifySignupFormToken(a).verdict).toBe('ok');
    expect(verifySignupFormToken(b).verdict).toBe('ok');
    expect(verifySignupFormToken(a).sig).not.toBe(verifySignupFormToken(b).sig);
  });

  it('a tampered nonce, or a token from before FU46-11, is handled', () => {
    const [ts, nonce, sig] = issueSignupFormToken(Date.now() - 10_000).split('.');
    expect(verifySignupFormToken(`${ts}.${nonce.slice(1)}x.${sig}`).verdict).toBe('invalid');
    expect(verifySignupFormToken(`${ts}.${sig}`).verdict).toBe('invalid');
  });

  it('two forms opened in the same millisecond each submit once (FU46-11, frozen clock)', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(t0);
      const [ga, gb] = await Promise.all([
        request(app()).get('/auth/merchant/signup-token'),
        request(app()).get('/auth/merchant/signup-token'),
      ]);
      const ta = ga.body.data.token as string;
      const tb = gb.body.data.token as string;
      expect(ta.split('.')[0]).toBe(String(t0));
      expect(tb.split('.')[0]).toBe(String(t0));
      expect(ta).not.toBe(tb);

      vi.setSystemTime(t0 + 10_000);
      const ra = await request(app())
        .post('/auth/merchant/signup')
        .send(body(`a@${freshDomain()}`, { formToken: ta }));
      const rb = await request(app())
        .post('/auth/merchant/signup')
        .send(body(`b@${freshDomain()}`, { formToken: tb }));
      expect([ra.status, rb.status]).toEqual([200, 200]);
      expect(signupMock).toHaveBeenCalledTimes(2);

      // Each is still single use.
      const replay = await request(app())
        .post('/auth/merchant/signup')
        .send(body(`c@${freshDomain()}`, { formToken: tb }));
      expect(replay.status).toBe(400);
      expect(replay.body.error.code).toBe('SIGNUP_FORM_INVALID');
      expect(signupMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the legacy pre-FU46-11 2-part token (<ms>.<hmac(ms)>) is refused (removed 2026-10-27, M-155)', () => {
    const ts = String(Date.now() - 10_000);
    const legacySig = crypto
      .createHmac('sha256', `${process.env.JWT_SECRET}:merchant-signup-form`)
      .update(ts)
      .digest('base64url');
    expect(verifySignupFormToken(`${ts}.${legacySig}`).verdict).toBe('invalid');
  });

  it('the fill-time floor is configurable', async () => {
    process.env.SIGNUP_MIN_FILL_MS = '0';
    const res = await request(app())
      .post('/auth/merchant/signup')
      .send(body(`a@${freshDomain()}`, { formToken: tokenAged(0) }));
    expect(res.status).toBe(200);
  });

  it('refuses a missing, forged, or expired token with one generic code', async () => {
    const email = `a@${freshDomain()}`;
    const missing = await request(app())
      .post('/auth/merchant/signup')
      .send(body(email, { formToken: undefined }));
    const forged = await request(app())
      .post('/auth/merchant/signup')
      .send(body(email, { formToken: `${Date.now() - 10_000}.AAAA` }));
    const tampered = await request(app())
      .post('/auth/merchant/signup')
      .send(
        body(email, { formToken: tokenAged(10_000).replace(/^\d+/, String(Date.now() - 20_000)) })
      );
    const expired = await request(app())
      .post('/auth/merchant/signup')
      .send(body(email, { formToken: tokenAged(7 * 60 * 60 * 1000) }));
    for (const r of [missing, forged, tampered, expired]) {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('SIGNUP_FORM_INVALID');
    }
    expect(signupMock).not.toHaveBeenCalled();
  });

  it('a form token works once (replay is refused)', async () => {
    const formToken = tokenAged(10_000);
    const email = `a@${freshDomain()}`;
    const first = await request(app())
      .post('/auth/merchant/signup')
      .send(body(email, { formToken }));
    const replay = await request(app())
      .post('/auth/merchant/signup')
      .send(body(email, { formToken }));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('SIGNUP_FORM_INVALID');
  });

  it('a validation failure does not burn the token (the visitor can fix and resubmit)', async () => {
    const formToken = tokenAged(10_000);
    const email = `a@${freshDomain()}`;
    const weak = await request(app())
      .post('/auth/merchant/signup')
      .send(body(email, { formToken, password: 'weak' }));
    expect(weak.status).toBe(400);
    const fixed = await request(app())
      .post('/auth/merchant/signup')
      .send(body(email, { formToken }));
    expect(fixed.status).toBe(200);
  });

  it('refuses a disposable domain, including subdomains, case-insensitively', async () => {
    for (const email of ['a@mailinator.com', 'a@x.guerrillamail.com', 'A@YOPMAIL.COM']) {
      const res = await request(app()).post('/auth/merchant/signup').send(body(email));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
    }
    expect(signupMock).not.toHaveBeenCalled();
  });

  it('per-email-domain daily cap: the Nth+1 signup from one domain is refused; major providers are exempt', async () => {
    process.env.SIGNUP_EMAIL_DOMAIN_DAILY_CAP = '3';
    const domain = freshDomain();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(app())
        .post('/auth/merchant/signup')
        .send(body(`u${i}@${domain}`));
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    // Another domain has its own budget.
    const other = await request(app())
      .post('/auth/merchant/signup')
      .send(body(`u@${freshDomain()}`));
    expect(other.status).toBe(200);

    // gmail is never capped per domain (per-IP limits cover it).
    for (let i = 0; i < 5; i++) {
      const r = await request(app())
        .post('/auth/merchant/signup')
        .send(body(`g${crypto.randomUUID().slice(0, 6)}@gmail.com`));
      expect(r.status).toBe(200);
    }
  });

  it('refusals never depend on whether the ADDRESS already has an account', async () => {
    // The service answers the same generic body for new and existing addresses;
    // the gate never consults the user table. Both succeed identically.
    signupMock.mockResolvedValueOnce({ emailVerificationSent: true });
    const a = await request(app())
      .post('/auth/merchant/signup')
      .send(body(`new@${freshDomain()}`));
    signupMock.mockResolvedValueOnce({ emailVerificationSent: true });
    const b = await request(app())
      .post('/auth/merchant/signup')
      .send(body(`existing@${freshDomain()}`));
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});

describe('GET /signup-token', () => {
  it('issues a token that verifies once old enough', async () => {
    const res = await request(app()).get('/auth/merchant/signup-token');
    expect(res.status).toBe(200);
    const token = res.body.data.token as string;
    expect(verifySignupFormToken(token).verdict).toBe('too_fast');
    expect(verifySignupFormToken(token, Date.now() + 10_000).verdict).toBe('ok');
  });
});

describe('signup velocity limiters', () => {
  function limited(kind: 'ip' | 'net', max: number, ip: string) {
    const a = express();
    a.set('trust proxy', true);
    a.use(express.json());
    const prefix = `test-signup-${kind}-${crypto.randomUUID()}`;
    const mw =
      kind === 'ip'
        ? createSignupIpVelocityLimiter({ skip: () => false, max: () => max, prefix })
        : createSignupSubnetVelocityLimiter({ skip: () => false, max: () => max, prefix });
    a.post('/s', mw, (_req, res) => {
      res.json({ ok: true });
    });
    return (xff: string = ip) => request(a).post('/s').set('X-Forwarded-For', xff).send({});
  }

  it('per-IP: blocked after the budget, other IPs unaffected', async () => {
    const hit = limited('ip', 2, '203.0.113.5');
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect((await hit('198.51.100.9')).status).toBe(200);
  });

  it('per-/24: a different host in the same /24 shares the budget', async () => {
    const hit = limited('net', 3, '203.0.113.1');
    expect((await hit('203.0.113.1')).status).toBe(200);
    expect((await hit('203.0.113.77')).status).toBe(200);
    expect((await hit('203.0.113.200')).status).toBe(200);
    expect((await hit('203.0.113.9')).status).toBe(429);
    // A different /24 is a fresh budget.
    expect((await hit('203.0.114.1')).status).toBe(200);
  });

  it('subnet key: IPv4 -> /24, mapped IPv6 -> /24, IPv6 -> /64', () => {
    expect(signupSubnetKey('203.0.113.77')).toBe('203.0.113.0/24');
    expect(signupSubnetKey('::ffff:203.0.113.5')).toBe('203.0.113.0/24');
    expect(signupSubnetKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(
      signupSubnetKey('2001:db8:1:2:1111:2222:3333:4444')
    );
    expect(signupSubnetKey('2001:db8:1:2::1')).not.toBe(signupSubnetKey('2001:db8:1:3::1'));
  });
});
