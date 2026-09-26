/**
 * #1737 (S2-tenancy-rls, 2026-09-25): `merchantMcpLimiterKey`'s unauthenticated
 * branch returned `mmcp-ip:${req.ip}` raw — unlike every other custom
 * `keyGenerator` in this repo (security.ts, wa-bridge.routes.ts), which all
 * run the IP through `ipKeyGenerator()` first. `express-rate-limit` normalizes
 * IPv6 to its /64 prefix there; skipping it here meant an IPv6 attacker could
 * rotate the low 64 bits of their address to land in a fresh bucket on every
 * request, defeating the 120/min cap on this credential-stuffing surface
 * (`POST /api/v1/mcp/admin/:storeSlug`, reached before any key is verified).
 *
 * This suite executes the key function directly rather than driving the route
 * over HTTP, matching `reset-email-limiter.test.ts` / `refresh-limiter-bucket
 * .test.ts`: `skipForLoadTestOrTests` disables every limiter under vitest, so
 * no HTTP-level test could ever observe a 429.
 */

import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { merchantMcpLimiterKey } from '@api/routes/mcp-admin.routes';

function req(ip: string, header?: string): Request {
  return {
    ip,
    get: (name: string) => (name.toLowerCase() === 'x-merchant-key' ? header : undefined),
  } as unknown as Request;
}

describe('merchantMcpLimiterKey (#1737)', () => {
  it('collapses two IPv6 addresses that only differ in their low 64 bits into ONE bucket', () => {
    const a = merchantMcpLimiterKey(req('2001:db8::aaaa:0:0:1'));
    const b = merchantMcpLimiterKey(req('2001:db8::bbbb:0:0:2'));
    expect(a).toBe(b);
  });

  it('still separates two genuinely different IPv4 callers', () => {
    const a = merchantMcpLimiterKey(req('1.1.1.1'));
    const b = merchantMcpLimiterKey(req('2.2.2.2'));
    expect(a).not.toBe(b);
  });

  it('keys on the presented merchant key, not the IP, when one is present', () => {
    const a = merchantMcpLimiterKey(req('1.1.1.1', 'secret-key'));
    const b = merchantMcpLimiterKey(req('9.9.9.9', 'secret-key'));
    expect(a).toBe(b);
    expect(a.startsWith('mmcp:')).toBe(true);
  });
});
