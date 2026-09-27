/**
 * S5-3 / S5-4 (2026-09-22 security audit).
 *
 * S5-3: `/forgot-password` and `/reset-password` sat only behind `authLimiter`
 * (15 requests / 15 minutes / IP+email) — sized for credential-stuffing
 * request VOLUME, not for reset-EMAIL flooding (15 reset emails to one inbox
 * in 15 minutes is still inside that budget). `resetEmailLimiterKey` backs a
 * tighter, account-scoped, IP-independent 3/hour budget stacked in front of
 * it on `/forgot-password`.
 *
 * S5-4: `/verify-email` had no rate limiter at all, unlike every sibling
 * unauthenticated auth-lookup route on the same router.
 *
 * This suite executes the key function directly rather than driving the
 * route over HTTP: `skipForLoadTestOrTests` (`middleware/security.ts`) is
 * `isTestEnv || …`, so every limiter is fully disabled under vitest and no
 * HTTP-level test could ever observe a 429 — see `refresh-limiter-bucket.
 * test.ts` for the same reasoning applied to `refreshLimiterKey`. The route
 * source is read directly to prove the limiters are actually WIRED, since a
 * key generator that is correct but never attached to a route is a no-op.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { resetEmailLimiterKey, verifyEmailLimiterKey } from '@api/middleware/security';

function req(body: unknown): Request {
  return { body } as unknown as Request;
}

describe('resetEmailLimiterKey (S5-3)', () => {
  it('gives two different emails different buckets', () => {
    const a = resetEmailLimiterKey(req({ email: 'a@example.com' }));
    const b = resetEmailLimiterKey(req({ email: 'b@example.com' }));
    expect(a).not.toBe(b);
  });

  it('normalises case and whitespace so the same account cannot get a fresh bucket by varying them', () => {
    const canonical = resetEmailLimiterKey(req({ email: 'ahmad@example.com' }));
    const upper = resetEmailLimiterKey(req({ email: 'Ahmad@Example.com' }));
    const padded = resetEmailLimiterKey(req({ email: '  ahmad@example.com  ' }));
    expect(upper).toBe(canonical);
    expect(padded).toBe(canonical);
  });

  it('has no IP component — the account budget must not be resettable by rotating source IPs', () => {
    // The key generator's signature only takes the request; assert it never
    // reads `req.ip` by checking a request WITHOUT an `ip` property produces
    // the same key as an otherwise-identical one that has one.
    const withIp = resetEmailLimiterKey({
      body: { email: 'a@x.com' },
      ip: '1.1.1.1',
    } as unknown as Request);
    const withoutIp = resetEmailLimiterKey({ body: { email: 'a@x.com' } } as unknown as Request);
    expect(withIp).toBe(withoutIp);
  });

  it('falls back to a shared unknown bucket for a missing/non-string email, never throws', () => {
    expect(() => resetEmailLimiterKey(req({}))).not.toThrow();
    expect(resetEmailLimiterKey(req({}))).toBe(resetEmailLimiterKey(req({ email: 123 })));
  });
});

describe('S5-3 / S5-4: the limiters are actually wired onto their routes', () => {
  const routesSrc = fs.readFileSync(
    path.resolve(__dirname, '../../apps/api/src/routes/auth.routes.ts'),
    'utf-8'
  );

  it('POST /forgot-password is behind both authLimiter and resetEmailLimiter', () => {
    const match = routesSrc.match(/router\.post\(\s*'\/forgot-password',([\s\S]*?)async \(req/);
    expect(match, 'could not find the /forgot-password route handler').not.toBeNull();
    const middlewareBlock = match![1];
    expect(middlewareBlock).toContain('authLimiter');
    expect(middlewareBlock).toContain('resetEmailLimiter');
  });

  it('POST /verify-email is behind verifyEmailLimiter, not the shared authLimiter bucket', () => {
    // #1863: authLimiter's key is `<ip>-<email || 'unknown'>` and this route
    // posts no email, so riding authLimiter pooled every verification click
    // from an IP into the SAME bucket as /reset-password. verifyEmailLimiter
    // has its own store namespace (see makeRateLimitStore's `prefix`) and a
    // budget sized for shared-IP signup bursts instead.
    const match = routesSrc.match(/router\.post\(\s*'\/verify-email',([\s\S]*?)async \(req/);
    expect(match, 'could not find the /verify-email route handler').not.toBeNull();
    const middlewareBlock = match![1];
    expect(middlewareBlock).toContain('verifyEmailLimiter');
    expect(middlewareBlock).not.toContain('authLimiter');
  });
});

describe('verifyEmailLimiterKey (#1863)', () => {
  it("is IP-only — it never pools with authLimiter's email-keyed bucket", () => {
    const key = verifyEmailLimiterKey({
      ip: '1.1.1.1',
      body: { token: 'abc' },
    } as unknown as Request);
    expect(key).not.toContain('unknown');
  });

  it('gives two different source IPs different buckets', () => {
    const a = verifyEmailLimiterKey({ ip: '1.1.1.1', body: {} } as unknown as Request);
    const b = verifyEmailLimiterKey({ ip: '2.2.2.2', body: {} } as unknown as Request);
    expect(a).not.toBe(b);
  });

  it('is NOT keyed on the presented token — the token is unverified here, so keying on it would let an attacker mint an unlimited number of fresh buckets by varying the string', () => {
    const a = verifyEmailLimiterKey({
      ip: '1.1.1.1',
      body: { token: 'aaa' },
    } as unknown as Request);
    const b = verifyEmailLimiterKey({
      ip: '1.1.1.1',
      body: { token: 'bbb' },
    } as unknown as Request);
    expect(a).toBe(b);
  });
});
