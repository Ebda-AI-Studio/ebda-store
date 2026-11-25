import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveResilient,
  __resetResolveCacheForTest,
  type ResolveDeps,
} from '../store-resolve-cache';
import { noteDefinitiveMiss, MISS_MEMO_TTL_MS } from '../../../resolve-miss-memo';
import { storeVerdict, resetStoreVerdicts } from '../../../store-edge-cache';
import { StoreTemporarilyUnavailableError } from '../store-unavailable';

/** QA-90: a definitive 404 seen by the edge verdict layer spares the render its R2 read + API call (10 s, bounded). */
let t = 1_800_000_000_000;
const deps = (): ResolveDeps => ({
  r2: null,
  now: () => t,
  sleep: async () => {},
  random: () => 0,
  waitUntil: () => {},
});
const res = (status: number) => ({ ok: status < 300, status, json: async () => ({}) }) as Response;

beforeEach(() => {
  __resetResolveCacheForTest();
  resetStoreVerdicts();
});

describe('QA-90 shared definitive-miss memo', () => {
  it('edge 404 verdict => the resolver answers null without calling the API', async () => {
    const fetcher = vi.fn(async () => res(404));
    await storeVerdict('cold-1.ebda.app', 'https://api', fetcher as never, t);
    const fresh = vi.fn(async () => ({ id: 'x' }));
    expect(await resolveResilient('cold-1.ebda.app', 'cold-1.ebda.app', fresh, deps())).toBeNull();
    expect(fresh).not.toHaveBeenCalled();
  });

  it('a NEW store at that host resolves once the TTL passes', async () => {
    noteDefinitiveMiss('cold-2.ebda.app', t);
    t += MISS_MEMO_TTL_MS + 1;
    const fresh = vi.fn(async () => ({ id: 'new-store' }));
    expect(await resolveResilient('cold-2.ebda.app', 'cold-2.ebda.app', fresh, deps())).toEqual({
      id: 'new-store',
    });
  });

  it('a 503 / network error is never recorded as unknown', async () => {
    await storeVerdict('cold-3.ebda.app', 'https://api', (async () => res(503)) as never, t);
    await storeVerdict(
      'cold-3.ebda.app',
      'https://api',
      (async () => {
        throw new Error('net');
      }) as never,
      t + 61_000
    );
    const fresh = vi.fn(async () => ({ id: 'live' }));
    expect(await resolveResilient('cold-3.ebda.app', 'cold-3.ebda.app', fresh, deps())).toEqual({
      id: 'live',
    });
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('a transient resolver failure still throws, never null', async () => {
    const fresh = async () => {
      throw new StoreTemporarilyUnavailableError('503');
    };
    await expect(
      resolveResilient('cold-4.ebda.app', 'cold-4.ebda.app', fresh, deps())
    ).rejects.toThrow();
  });
});
