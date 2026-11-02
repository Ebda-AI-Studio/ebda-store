/**
 * NEON-SCALE-1 rule 1 / Ruling NZ-D1: store directory reads are cached (positive AND negative), call-counted against D1,
 * status-filtered on the way out, malformed / reserved keys cost nothing, and writes invalidate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kv = new Map<string, unknown>();
const d1Calls: Array<Record<string, unknown>> = [];
let rows: Record<string, { id: string; status: string }> = {};

vi.mock('../../apps/api/src/lib/public-cache', () => ({
  getCached: async (key: string, _ttl: number, fn: () => Promise<unknown>) => {
    if (kv.has(key)) return kv.get(key);
    const v = await fn();
    kv.set(key, v);
    return v;
  },
  invalidateCached: async (key: string) => void kv.delete(key),
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  lookupStore: async (match: Record<string, unknown>) => {
    d1Calls.push(match);
    const k = String(match.id ?? match.slug ?? match.domain);
    return rows[k] ?? null;
  },
}));

import {
  lookupStoreCached,
  invalidateStoreDirectory,
} from '../../apps/api/src/lib/store-directory';

const ID = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  kv.clear();
  d1Calls.length = 0;
  rows = { alpha: { id: ID, status: 'active' }, [ID]: { id: ID, status: 'active' } };
});

describe('lookupStoreCached', () => {
  it('a hit costs one D1 read for any number of requests', async () => {
    for (let i = 0; i < 50; i++)
      expect(await lookupStoreCached({ slug: 'alpha' }, ['active'])).toEqual({
        id: ID,
        status: 'active',
      });
    expect(d1Calls).toHaveLength(1);
  });
  it('an unknown slug is negatively cached: 100 probes, one D1 read', async () => {
    for (let i = 0; i < 100; i++) expect(await lookupStoreCached({ slug: 'nobody' })).toBeNull();
    expect(d1Calls).toHaveLength(1);
  });
  it('malformed, reserved and overlong keys cost no D1 read and no cache entry', async () => {
    for (const slug of ['', 'UPPER_CASE!', 'a'.repeat(80), 'www', 'api', '../x'])
      expect(await lookupStoreCached({ slug })).toBeNull();
    expect(await lookupStoreCached({ id: 'not-a-uuid' })).toBeNull();
    expect(await lookupStoreCached({ domain: 'no spaces.com' })).toBeNull();
    expect(d1Calls).toHaveLength(0);
    expect(kv.size).toBe(0);
  });
  it('one status-agnostic entry serves different status filters', async () => {
    rows.beta = { id: ID, status: 'suspended' };
    expect(await lookupStoreCached({ slug: 'beta' }, ['active'])).toBeNull();
    expect(await lookupStoreCached({ slug: 'beta' }, ['active', 'suspended'])).toEqual({
      id: ID,
      status: 'suspended',
    });
    expect(d1Calls).toHaveLength(1);
  });
  it('a multi-key match is not cached (precedence stays in lookupStore)', async () => {
    await lookupStoreCached({ id: ID, slug: 'alpha' });
    await lookupStoreCached({ id: ID, slug: 'alpha' });
    expect(d1Calls).toHaveLength(2);
  });
  it('invalidateStoreDirectory drops id, slug, host and domain entries so the next read refills', async () => {
    await lookupStoreCached({ slug: 'alpha' });
    await lookupStoreCached({ id: ID });
    rows.alpha = { id: ID, status: 'suspended' };
    await invalidateStoreDirectory(ID, 'alpha', 'shop.example.com');
    d1Calls.length = 0;
    expect(await lookupStoreCached({ slug: 'alpha' }, ['active'])).toBeNull();
    expect(d1Calls).toHaveLength(1);
  });
});

describe('write paths do not use the cache (Ruling NZ-D1)', () => {
  it('only read routes import lookupStoreCached', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('grep', ['-rl', 'lookupStoreCached', 'apps/api/src'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(out).toEqual([
      'apps/api/src/lib/store-directory.ts',
      'apps/api/src/mcp/resolve-store.ts',
      'apps/api/src/routes/public-store-layout.routes.ts',
      'apps/api/src/routes/public.routes.ts',
    ]);
  });
});
