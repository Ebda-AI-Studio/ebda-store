/**
 * FORCE-API-2D/2E/2F (issue 2470) — a dropped Neon pooler connection on an
 * idempotent read is retried a bounded number of times; nothing else is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@force/database';

const redisMock = vi.hoisted(() => ({
  get: vi.fn(async () => null as unknown),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  deleteByPattern: vi.fn(async () => 0),
  // FIX-001/002: healthy Redis with generations that never move.
  isAvailable: vi.fn(() => true),
  getCacheGenerations: vi.fn(async (names: string[]) => names.map(() => null)),
  bumpCacheGeneration: vi.fn(async () => {}),
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({ redis: redisMock }));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));

import { retryTransientRead, isTransientConnectionError } from '../../apps/api/src/lib/db-retry';
import { getCached } from '../../apps/api/src/lib/public-cache';

const known = (code: string, message = 'x') =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
const unknownReq = (message: string) =>
  new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: 'test' });

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
});

describe('isTransientConnectionError', () => {
  it.each([
    ['P1001', known('P1001', "Can't reach database server")],
    ['P1002', known('P1002')],
    ['P1017', known('P1017', 'Server has closed the connection.')],
    [
      'unknown-request "Server has closed the connection"',
      unknownReq('Server has closed the connection.'),
    ],
  ])('%s is transient', (_n, err) => expect(isTransientConnectionError(err)).toBe(true));

  it.each([
    ['P2002 unique', known('P2002')],
    ['P2025 not found', known('P2025')],
    ['P2028 tx closed', known('P2028')],
    ['plain Error', new Error('boom')],
    ['non-error', 'nope'],
  ])('%s is NOT transient', (_n, err) => expect(isTransientConnectionError(err)).toBe(false));
});

describe('retryTransientRead', () => {
  it('retries then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(known('P1001'))
      .mockRejectedValueOnce(unknownReq('Server has closed the connection.'))
      .mockResolvedValue('rows');
    await expect(retryTransientRead(fn, { baseDelayMs: 1 })).resolves.toBe('rows');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the cap and rethrows the original error', async () => {
    const err = known('P1017');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryTransientRead(fn, { retries: 2, baseDelayMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries — bounded
  });

  it('does not retry a non-transient error', async () => {
    const fn = vi.fn().mockRejectedValue(known('P2025'));
    await expect(retryTransientRead(fn, { baseDelayMs: 1 })).rejects.toMatchObject({
      code: 'P2025',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off with jitter (not a tight loop)', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce(known('P1001')).mockResolvedValue('ok');
      const p = retryTransientRead(fn, { baseDelayMs: 50 });
      await vi.advanceTimersByTimeAsync(10);
      expect(fn).toHaveBeenCalledTimes(1); // still waiting
      await vi.advanceTimersByTimeAsync(100);
      await expect(p).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getCached — the shared public-read layer', () => {
  it('survives a transient pooler drop in the fetcher and caches the result', async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(known('P1001')).mockResolvedValue({ n: 1 });
    await expect(getCached('public:products:retry-ok', 60, fetchFn)).resolves.toEqual({ n: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(redisMock.set).toHaveBeenCalledTimes(1);
  });

  it('gives up on a sustained outage: error surfaces, nothing is cached', async () => {
    const fetchFn = vi.fn().mockRejectedValue(known('P1001'));
    await expect(getCached('public:products:retry-down', 60, fetchFn)).rejects.toMatchObject({
      code: 'P1001',
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('a business error from the fetcher is not retried', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('Store not found'));
    await expect(getCached('public:store:retry-biz', 60, fetchFn)).rejects.toThrow(
      'Store not found'
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
