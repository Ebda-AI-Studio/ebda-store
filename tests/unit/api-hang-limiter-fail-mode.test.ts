/**
 * API-HANG-2: when the AuthState Durable Object does not answer within AUTH_STATE_TIMEOUT_MS, a credential/write limiter FAILS
 * CLOSED (its normal 429 body + Retry-After) and a public read limiter fails OPEN (the request is served). One case per class,
 * through the real express-rate-limit with the limiter's real options shape, plus the pinned fail-open list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import {
  CfRateLimitStore,
  FAIL_CLOSED_HITS,
  RL_FAIL_OPEN_PREFIXES,
  failsOpen,
} from '../../apps/api/src/cf/rate-limit-store';
import {
  AUTH_STATE_TIMEOUT_MS,
  AuthStateTimeoutError,
} from '../../apps/api/src/cf/auth-state-client';
import { clearCfBindings, setCfBindings, type CfBindings } from '../../apps/api/src/cf/bindings';

function stuckAuthState() {
  setCfBindings({
    AUTH_STATE: {
      idFromName: (n: string) => n,
      get: () => ({ apply: () => new Promise<never>(() => undefined) }),
    },
  } as unknown as CfBindings);
}

afterEach(() => {
  vi.useRealTimers();
  clearCfBindings();
});

describe('which limiters may fail open', () => {
  it('only the anonymous public READ limiters; anything else (incl. a future limiter) fails closed', () => {
    expect([...RL_FAIL_OPEN_PREFIXES].sort()).toEqual(
      [
        'rl:public-search:',
        'rl:public-tenant:',
        'rl:public:',
        'rl:store-miss:',
        'rl:store-resolve:',
        'rl:view-ingest:',
      ].sort()
    );
    for (const closed of [
      'rl:auth:1.2.3.4-a@b.c',
      'rl:auth-ip-fail:1.2.3.4',
      'rl:auth-ip:1.2.3.4',
      'rl:auth-email-any:a@b.c',
      'rl:refresh:x',
      'rl:refresh-ip:x',
      'rl:reset-email:a@b.c',
      'rl:verify-email:a@b.c',
      'rl:passkey-stepup:u',
      'rl:merchant-signup-ip:1.2.3.4',
      'rl:global:1.2.3.4',
      'rl:write:1.2.3.4',
      'rl:payment:1.2.3.4',
      'rl:coupon-validate:x',
      'rl:something-new:x',
    ])
      expect(failsOpen(closed), closed).toBe(false);
  });
});

describe('the store on a stuck AuthState', () => {
  it('credential limiter: increment answers over-the-limit at the deadline (fail closed)', async () => {
    vi.useFakeTimers();
    stuckAuthState();
    const store = new CfRateLimitStore('rl:auth:');
    store.init({ windowMs: 900_000 } as never);
    const p = store.increment('1.2.3.4-a@b.c');
    await vi.advanceTimersByTimeAsync(AUTH_STATE_TIMEOUT_MS);
    const info = await p;
    expect(info.totalHits).toBe(FAIL_CLOSED_HITS);
    expect(info.resetTime!.getTime()).toBeGreaterThan(Date.now());
  });

  it('public read limiter: increment rejects with AuthStateTimeoutError (passOnStoreError serves it)', async () => {
    vi.useFakeTimers();
    stuckAuthState();
    const store = new CfRateLimitStore('rl:public:');
    store.init({ windowMs: 60_000 } as never);
    const p = store.increment('1.2.3.4');
    const assertion = expect(p).rejects.toBeInstanceOf(AuthStateTimeoutError);
    await vi.advanceTimersByTimeAsync(AUTH_STATE_TIMEOUT_MS);
    await assertion;
  });
});

describe('through express-rate-limit (real limiter options shape)', () => {
  const app = (name: string) => {
    const a = express();
    a.use(
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 5,
        standardHeaders: true,
        legacyHeaders: false,
        passOnStoreError: true,
        store: new CfRateLimitStore(`rl:${name}:`),
        message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts' } },
      })
    );
    a.post('/x', (_req, res) => void res.status(200).json({ ok: true }));
    return a;
  };

  it('a credential limiter answers its normal 429 body with Retry-After, in ~the deadline (not a hang)', async () => {
    stuckAuthState();
    const t0 = Date.now();
    const res = await request(app('auth')).post('/x');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts' },
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(AUTH_STATE_TIMEOUT_MS + 1_500);
  }, 10_000);

  it('a public read limiter serves the request', async () => {
    stuckAuthState();
    const res = await request(app('public')).post('/x');
    expect(res.status).toBe(200);
  }, 10_000);
});
