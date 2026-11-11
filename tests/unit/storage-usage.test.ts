/**
 * S3-X8: maxStorageMb was declared and shown but never enforced (countUsage returned null).
 * Usage now comes from the R2 listing; every upload route gates on it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  USAGE_MAX_PAGES,
  USAGE_TTL_MS,
  cachedStoreBytes,
  resetStorageUsageCache,
  sumStoreBytes,
  type ListPage,
} from '../../apps/api/src/lib/storage-usage';

const pages = (...p: number[][]): ListPage => {
  let i = 0;
  return async () => {
    const sizes = p[i++] ?? [];
    return { sizes, nextCursor: i < p.length ? `c${i}` : null };
  };
};

beforeEach(resetStorageUsageCache);

describe('sumStoreBytes', () => {
  it('sums every page', async () => {
    expect(await sumStoreBytes(pages([1, 2], [3], [4, 5]))).toBe(15);
  });
  it('stops at the page cap and reports a lower bound, never zero', async () => {
    let calls = 0;
    const endless: ListPage = async () => (calls++, { sizes: [10], nextCursor: 'more' });
    expect(await sumStoreBytes(endless)).toBe(10 * USAGE_MAX_PAGES);
    expect(calls).toBe(USAGE_MAX_PAGES);
  });
});

describe('cachedStoreBytes (60 s, BOUNDED-stale)', () => {
  it('lists once inside the window and again after it', async () => {
    let calls = 0;
    const list: ListPage = async () => (calls++, { sizes: [7], nextCursor: null });
    expect(await cachedStoreBytes('s', list, 1000)).toBe(7);
    expect(await cachedStoreBytes('s', list, 1000 + USAGE_TTL_MS - 1)).toBe(7);
    expect(calls).toBe(1);
    await cachedStoreBytes('s', list, 1000 + USAGE_TTL_MS);
    expect(calls).toBe(2);
  });
});

describe('upload routes gate on the storage ceiling', () => {
  const src = readFileSync(join(__dirname, '../../apps/api/src/routes/upload.routes.ts'), 'utf8');
  it('image, images, video and font each call assertStorageRoom', () => {
    expect(src.match(/assertStorageRoom\(/g)?.length).toBe(4);
  });
  it('a failed bucket listing fails OPEN, with a warning', () => {
    const svc = readFileSync(
      join(__dirname, '../../apps/api/src/services/plan-limit.service.ts'),
      'utf8'
    );
    expect(svc).toMatch(/storage usage unavailable, allowing the upload/);
  });
  it('countUsage no longer returns null for maxStorageMb', () => {
    const svc = readFileSync(
      join(__dirname, '../../apps/api/src/services/plan-limit.service.ts'),
      'utf8'
    );
    expect(svc).not.toMatch(/maxStorageMb':\s*\n\s*return null/);
    expect(svc).toMatch(/storageUsageMb\(storeId\)/);
  });
});
