/**
 * Ruling RESOLVE-BULLETPROOF-1: a storefront purge that does not land is retried (bounded), because the storefront's
 * per-store purge epoch is written only when it lands; a dropped purge let a suspended store keep resolving from cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PURGE_RETRY_DELAYS_MS,
  revalidateStorefrontWithRetry,
} from '../../apps/api/src/lib/revalidate-storefront';

const env = { ...process.env };
const fetchMock = vi.fn();
const sleep = vi.fn(async () => undefined);

beforeEach(() => {
  process.env.REVALIDATE_SECRET = 's3cret';
  process.env.STOREFRONT_REVALIDATE_URL = 'https://web.example';
  fetchMock.mockReset();
  sleep.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

const res = (status: number) => new Response('{}', { status });

describe('revalidateStorefrontWithRetry', () => {
  it('retries a network error and a 502, then lands', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    await expect(revalidateStorefrontWithRetry({ domain: 'shop.example' }, sleep)).resolves.toBe(
      'ok'
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(c => c[0])).toEqual(PURGE_RETRY_DELAYS_MS);
  });

  it('retries a 429', async () => {
    fetchMock.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
    await expect(revalidateStorefrontWithRetry({ slug: 'acme' }, sleep)).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is bounded: 3 attempts, then reports failed', async () => {
    fetchMock.mockResolvedValue(res(500));
    await expect(revalidateStorefrontWithRetry({ slug: 'acme' }, sleep)).resolves.toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1 + PURGE_RETRY_DELAYS_MS.length);
  });

  it('never retries a configuration fault (401 / 503) or a 4xx', async () => {
    for (const status of [401, 503, 400]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(res(status));
      await expect(revalidateStorefrontWithRetry({ slug: 'acme' }, sleep)).resolves.toBe(
        'rejected'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});
