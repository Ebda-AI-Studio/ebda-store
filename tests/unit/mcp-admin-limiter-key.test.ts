/**
 * #1737 (S2-tenancy-rls, 2026-09-25): `merchantMcpLimiterKey`'s unauthenticated
 * branch returned `mmcp-ip:${req.ip}` raw — unlike every other custom
 * `keyGenerator` in this repo (security.ts), which all
 * run the IP through `ipKeyGenerator()` first. `express-rate-limit` normalizes
 * IPv6 to its /64 prefix there; skipping it here meant an IPv6 attacker could
 * rotate the low 64 bits of their address to land in a fresh bucket on every
 * request, defeating the 120/min cap on this credential-stuffing surface
 * (`POST /api/v1/mcp/admin/:storeSlug`, reached before any key is verified).
 *
 * #1733 P1 (scoped audit, 2026-09-26): the global-rate-limit bypass for this
 * path (`global-rate-limit-skip.ts`) was justified by "already bound by its
 * own per-key limiter" — false, because a caller presenting NO key, or a
 * ROTATED bogus one, minted a fresh `mmcp:<hash>` bucket every request and was
 * never bound by anything. Fixed by making the key ALWAYS IP-qualified
 * (`mmcp:${ip}:${fp}`) and adding `merchantMcpIpLimiter`, a genuinely
 * IP-ONLY limiter mounted ahead of it — nothing the caller sends can choose
 * or split THAT bucket, so it is the real backstop the bypass now leans on.
 *
 * This suite executes the key functions directly rather than driving the
 * route over HTTP, matching `reset-email-limiter.test.ts` /
 * `refresh-limiter-bucket.test.ts`'s pattern for the same class of limiter —
 * proving the KEY a caller lands in (which determines whether the cap can
 * ever be reached) rather than firing hundreds of requests to observe a 429.
 */

import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import {
  merchantMcpLimiterKey,
  merchantMcpIpLimiter,
  merchantMcpIpLimiterKey,
  merchantMcpLimiter,
} from '@api/routes/mcp-admin.routes';
import { hasPlausibleMerchantKeyShape, MERCHANT_KEY_PREFIX } from '@api/mcp/merchant-auth';

function req(ip: string, header?: string): Request {
  return {
    ip,
    get: (name: string) => (name.toLowerCase() === 'x-merchant-key' ? header : undefined),
  } as unknown as Request;
}

describe('merchantMcpLimiterKey (#1737, extended #1733)', () => {
  it('collapses two IPv6 addresses that only differ in their low 64 bits into ONE bucket', () => {
    const a = merchantMcpLimiterKey(req('2001:db8::aaaa:0:0:1'));
    const b = merchantMcpLimiterKey(req('2001:db8::bbbb:0:0:2'));
    expect(a).toBe(b);
  });

  it('still separates two genuinely different IPv4 callers with no key', () => {
    const a = merchantMcpLimiterKey(req('1.1.1.1'));
    const b = merchantMcpLimiterKey(req('2.2.2.2'));
    expect(a).not.toBe(b);
  });

  it('#1733: is now ALWAYS IP-qualified, even when a key is present — same key from two IPs no longer shares one bucket', () => {
    // Changed behaviour, deliberately: the fingerprint is a SECONDARY
    // sub-bucket under the IP, not a replacement for it. A merchant working
    // from two locations with the same key now gets separate headroom on
    // each rather than sharing one 120/min budget — strictly friendlier —
    // and `merchantMcpIpLimiter` below is what actually bounds an attacker,
    // so this key no longer has to carry that job alone.
    const a = merchantMcpLimiterKey(req('1.1.1.1', 'secret-key'));
    const b = merchantMcpLimiterKey(req('9.9.9.9', 'secret-key'));
    expect(a).not.toBe(b);
    expect(a.startsWith('mmcp:')).toBe(true);
    expect(b.startsWith('mmcp:')).toBe(true);
  });

  it('the SAME ip + SAME key always gets the SAME bucket', () => {
    const a = merchantMcpLimiterKey(req('1.1.1.1', 'secret-key'));
    const b = merchantMcpLimiterKey(req('1.1.1.1', 'secret-key'));
    expect(a).toBe(b);
  });

  it('#1733: rotating a bogus key from the SAME ip mints a DIFFERENT sub-bucket every time (the reported hole in this limiter alone)', () => {
    // This is the exact defect the P1 finding named: presence, not
    // verification, chooses the fingerprint sub-bucket. Proving it still
    // happens here is the point — `merchantMcpIpLimiter` (tested below) is
    // what closes it, not this key generator.
    const rotated = Array.from({ length: 5 }, (_, i) =>
      merchantMcpLimiterKey(req('1.1.1.1', `rotated-key-${i}`))
    );
    expect(new Set(rotated).size).toBe(5);
    // But every one of those buckets is still scoped under the SAME ip
    // prefix — the caller cannot escape the ip namespace, only fragment
    // within it, which is exactly why a SEPARATE ip-only limiter is needed
    // to bound the total.
    for (const key of rotated) {
      expect(key.startsWith('mmcp:1.1.1.1:')).toBe(true);
    }
  });

  it('a caller with no key at all gets one shared per-ip bucket, not a private one', () => {
    const a = merchantMcpLimiterKey(req('1.1.1.1'));
    const b = merchantMcpLimiterKey(req('1.1.1.1'));
    expect(a).toBe(b);
    expect(a).toBe('mmcp:1.1.1.1:none');
  });
});

describe('merchantMcpIpLimiterKey — the actual backstop (#1733)', () => {
  it('is IP-ONLY: nothing the caller sends can change or split this bucket', () => {
    const noKey = merchantMcpIpLimiterKey(req('1.1.1.1'));
    const withKey = merchantMcpIpLimiterKey(req('1.1.1.1', 'secret-key'));
    const rotated = merchantMcpIpLimiterKey(req('1.1.1.1', 'a-totally-different-rotated-key'));

    expect(withKey).toBe(noKey);
    expect(rotated).toBe(noKey);
  });

  it('still separates two different IPs', () => {
    expect(merchantMcpIpLimiterKey(req('1.1.1.1'))).not.toBe(
      merchantMcpIpLimiterKey(req('2.2.2.2'))
    );
  });

  it('normalizes IPv6 the same way merchantMcpLimiterKey does (no low-bits rotation escape)', () => {
    const a = merchantMcpIpLimiterKey(req('2001:db8::aaaa:0:0:1'));
    const b = merchantMcpIpLimiterKey(req('2001:db8::bbbb:0:0:2'));
    expect(a).toBe(b);
  });
});

describe('hasPlausibleMerchantKeyShape — cheap pre-DB rejection (#1733)', () => {
  const longEnough = `${MERCHANT_KEY_PREFIX}${'a'.repeat(32)}`;

  it('rejects a missing header', () => {
    expect(hasPlausibleMerchantKeyShape(req('1.1.1.1'))).toBe(false);
  });

  it('rejects a header with the wrong prefix', () => {
    expect(hasPlausibleMerchantKeyShape(req('1.1.1.1', `wrong_${'a'.repeat(32)}`))).toBe(false);
  });

  it('rejects a too-short header even with the right prefix', () => {
    expect(hasPlausibleMerchantKeyShape(req('1.1.1.1', `${MERCHANT_KEY_PREFIX}short`))).toBe(false);
  });

  it('accepts a plausibly-shaped key (still not a real verification)', () => {
    expect(hasPlausibleMerchantKeyShape(req('1.1.1.1', longEnough))).toBe(true);
  });
});

/**
 * …and the router actually mounts both limiters, in the right order, ahead of
 * the handler. A correct key generator wired to nothing is the same as no
 * limiter — matches `refresh-limiter-bucket.test.ts`'s wiring check for the
 * same reason.
 */
describe('POST /api/v1/mcp/admin/:storeSlug is wired to both limiters, IP-only first (#1733)', () => {
  it('mounts merchantMcpIpLimiter strictly before merchantMcpLimiter', async () => {
    const router = (await import('@api/routes/mcp-admin.routes')).default as unknown as {
      stack: Array<{ handle: unknown }>;
    };

    const handles = router.stack.map(l => l.handle);
    const ipLimiterIndex = handles.indexOf(merchantMcpIpLimiter);
    const keyLimiterIndex = handles.indexOf(merchantMcpLimiter);

    expect(ipLimiterIndex, 'merchantMcpIpLimiter not found on the router').toBeGreaterThanOrEqual(
      0
    );
    expect(keyLimiterIndex, 'merchantMcpLimiter not found on the router').toBeGreaterThanOrEqual(0);
    expect(ipLimiterIndex).toBeLessThan(keyLimiterIndex);
  });
});
