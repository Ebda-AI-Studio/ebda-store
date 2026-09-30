/**
 * Endpoint deprecation signalling (audit lens L15).
 *
 * A version prefix says which contract you are on; it does not say the one you
 * are on is going away. Before this, a merchant integration or the WBS bridge
 * learned an endpoint was retiring when it 404'd.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { deprecate, DEPRECATED_ENDPOINTS, __resetDeprecationWarnSampleForTests } =
  await import('@api/middleware/deprecation');
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

beforeEach(() => {
  vi.clearAllMocks();
  __resetDeprecationWarnSampleForTests();
});

describe('deprecate()', () => {
  // Regression for #1114: RFC 9745 and RFC 8594 disagree on date format.
  // Sunset (RFC 8594) takes an IMF-fixdate. Deprecation (RFC 9745) takes an
  // sf-date — `@<unix-seconds>` — NOT an IMF-fixdate; the header previously
  // sent IMF-fixdate for both, which is not a valid RFC 9745 Deprecation
  // value and would fail a spec-compliant client's parser.
  it('emits Deprecation as an RFC 9745 sf-date and Sunset as an RFC 8594 IMF-fixdate', () => {
    const { headers } = run(deprecate({ since: SINCE, sunset: SUNSET, reason: 'superseded' }));
    expect(headers['Deprecation']).toBe(`@${Math.floor(SINCE.getTime() / 1000)}`);
    expect(headers['Deprecation']).toMatch(/^@\d+$/);
    expect(headers['Sunset']).toBe(SUNSET.toUTCString());
    // toUTCString is the IMF-fixdate RFC 8594 requires, not ISO-8601.
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

  // Regression for #1117: the WARN fired unconditionally on every request
  // with no dedupe. A hot deprecated endpoint would flood the log at request
  // volume instead of once per interval — headers must still be set on
  // EVERY request (the client needs them every time), only the log is
  // sampled. Each test below uses its own route path — the dedupe map is
  // module-level state shared across this whole file's tests.
  describe('WARN sampling', () => {
    beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-09-10T00:00:00Z')));
    afterEach(() => vi.useRealTimers());

    function runAt(mw: ReturnType<typeof deprecate>, path: string) {
      const headers: Record<string, string> = {};
      const req = {
        originalUrl: path,
        method: 'GET',
        params: {},
        headers: {},
      } as unknown as Request;
      const res = {
        setHeader: (k: string, v: string) => void (headers[k] = v),
      } as unknown as Response;
      mw(req, res, vi.fn() as unknown as NextFunction);
      return headers;
    }

    it('logs only once for a burst of requests to the same route', () => {
      const mw = deprecate({ since: SINCE, sunset: SUNSET, reason: 'burst' });
      runAt(mw, '/api/v1/sample-burst');
      runAt(mw, '/api/v1/sample-burst');
      runAt(mw, '/api/v1/sample-burst');
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('still sets the Deprecation/Sunset headers on every request, sampled or not', () => {
      const mw = deprecate({ since: SINCE, sunset: SUNSET, reason: 'burst' });
      const first = runAt(mw, '/api/v1/sample-headers');
      const second = runAt(mw, '/api/v1/sample-headers');
      expect(first['Deprecation']).toBeDefined();
      expect(second['Deprecation']).toBe(first['Deprecation']);
      expect(second['Sunset']).toBe(first['Sunset']);
    });

    it('logs again for a DIFFERENT route even inside the same sample window', () => {
      const mw = deprecate({ since: SINCE, sunset: SUNSET, reason: 'burst' });
      runAt(mw, '/api/v1/sample-route-a');
      runAt(mw, '/api/v1/sample-route-b');
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('logs again once the sample interval elapses', () => {
      const mw = deprecate({ since: SINCE, sunset: SUNSET, reason: 'burst' });
      runAt(mw, '/api/v1/sample-interval');
      expect(logger.warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      runAt(mw, '/api/v1/sample-interval');
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('DEPRECATED_ENDPOINTS', () => {
  it('is empty — this ships the mechanism, not a deprecation', () => {
    expect(DEPRECATED_ENDPOINTS).toHaveLength(0);
  });
});
