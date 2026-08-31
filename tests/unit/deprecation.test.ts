/**
 * Endpoint deprecation signalling (audit lens L15).
 *
 * A version prefix says which contract you are on; it does not say the one you
 * are on is going away. Before this, a merchant integration or the WBS bridge
 * learned an endpoint was retiring when it 404'd.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { deprecate, DEPRECATED_ENDPOINTS } = await import('@api/middleware/deprecation');
const logger = (await import('@api/lib/logger')).default;

const SINCE = new Date('2026-09-01T00:00:00Z');
const SUNSET = new Date('2026-12-01T00:00:00Z');

function run(mw: ReturnType<typeof deprecate>) {
  const headers: Record<string, string> = {};
  const req = {
    originalUrl: '/api/v1/legacy',
    method: 'GET',
    params: { storeId: 'store-1' },
    headers: { 'user-agent': 'wbs-bridge/1.0', origin: 'https://wbs.example' },
  } as unknown as Request;
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  mw(req, res, next);
  return { headers, next };
}

beforeEach(() => vi.clearAllMocks());

describe('deprecate()', () => {
  it('emits Deprecation and Sunset as IMF-fixdate (RFC 9745 / RFC 8594)', () => {
    const { headers } = run(deprecate({ since: SINCE, sunset: SUNSET, reason: 'superseded' }));
    expect(headers['Deprecation']).toBe(SINCE.toUTCString());
    expect(headers['Sunset']).toBe(SUNSET.toUTCString());
    // toUTCString is the IMF-fixdate both RFCs require, not ISO-8601.
    expect(headers['Sunset']).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} /);
  });

  it('advertises a successor via Link rel=successor-version', () => {
    const { headers } = run(
      deprecate({ since: SINCE, sunset: SUNSET, successor: '/api/v1/new', reason: 'r' })
    );
    expect(headers['Link']).toBe('</api/v1/new>; rel="successor-version"');
  });

  it('omits Link when there is no successor', () => {
    const { headers } = run(deprecate({ since: SINCE, sunset: SUNSET, reason: 'removed' }));
    expect(headers['Link']).toBeUndefined();
  });

  it('NEVER blocks the request — a sunset that 410s early is an outage', () => {
    const { next } = run(deprecate({ since: SINCE, sunset: SUNSET, reason: 'r' }));
    expect(next).toHaveBeenCalledOnce();
  });

  it('warns with the caller identity, so the endpoint can actually be retired', () => {
    run(deprecate({ since: SINCE, sunset: SUNSET, reason: 'superseded by /new' }));
    // WARN not INFO: this exists to be noticed.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/v1/legacy',
        reason: 'superseded by /new',
        callerStore: 'store-1',
        userAgent: 'wbs-bridge/1.0',
      }),
      expect.stringContaining('deprecated-endpoint')
    );
  });

  it('throws at BOOT when sunset precedes since — a typo must not ship silently', () => {
    expect(() => deprecate({ since: SUNSET, sunset: SINCE, reason: 'r' })).toThrow(/must be after/);
  });
});

describe('DEPRECATED_ENDPOINTS', () => {
  it('is empty — this ships the mechanism, not a deprecation', () => {
    expect(DEPRECATED_ENDPOINTS).toHaveLength(0);
  });
});
