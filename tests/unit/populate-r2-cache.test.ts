import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { planUploads, uploadAll } from '../../scripts/ci/populate-r2-cache.mjs';

// Ruling DEPLOY-R2-POPULATE-2. Network-free: the real wrangler call is replaced by a stub.
const fakeKey = (key: string, o: { prefix?: string; buildId: string; cacheType: string }) =>
  `${o.prefix ?? 'incremental-cache'}/${o.buildId}/${key.replace(/\//g, '_')}.${o.cacheType}`;

describe('planUploads', () => {
  it('maps assets to keys with the fetch/cache type, build id and prefix', () => {
    const plan = planUploads(
      [
        { key: '/a', buildId: 'b1', isFetch: false, fullPath: '/x/a.cache' },
        { key: '/f', buildId: 'b1', isFetch: true, fullPath: '/x/f' },
      ],
      'pre',
      fakeKey
    );
    expect(plan).toEqual([
      { key: 'pre/b1/_a.cache', file: '/x/a.cache' },
      { key: 'pre/b1/_f.fetch', file: '/x/f' },
    ]);
  });
  it('rejects duplicate keys', () => {
    const a = { key: '/a', buildId: 'b', isFetch: false, fullPath: '/p' };
    expect(() => planUploads([a, a], undefined, fakeKey)).toThrow(/duplicate/);
  });
});

describe('uploadAll', () => {
  const plan = [1, 2, 3].map(i => ({ key: `k${i}`, file: `/f${i}` }));
  const opts = { sleep: async () => {}, log: () => {}, sizeOf: () => 10 };

  it('uploads every entry and sums bytes', async () => {
    const put = vi.fn(async () => ({ ok: true }));
    const r = await uploadAll(plan, 'bkt', put, opts);
    expect(r).toEqual({ count: 3, bytes: 30 });
    expect(put).toHaveBeenCalledWith('bkt', 'k2', '/f2');
  });
  it('retries a failing entry then succeeds', async () => {
    let n = 0;
    const put = vi.fn(async (_b: string, key: string) =>
      key === 'k1' && n++ < 2 ? { ok: false, error: 'boom' } : { ok: true }
    );
    const r = await uploadAll(plan, 'bkt', put, { ...opts, retries: 4 });
    expect(r.count).toBe(3);
    expect(put).toHaveBeenCalledTimes(5);
  });
  it('fails loud with the key after the bounded retries', async () => {
    const put = vi.fn(async (_b: string, key: string) =>
      key === 'k2' ? { ok: false, error: 'nope' } : { ok: true }
    );
    await expect(
      uploadAll(plan, 'bkt', put, { ...opts, retries: 3, concurrency: 1 })
    ).rejects.toThrow(/k2 after 3 attempts: nope/);
  });
});
