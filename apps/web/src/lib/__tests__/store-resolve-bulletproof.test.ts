import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Ruling RESOLVE-BULLETPROOF-1 — each test fails without the layer it names
 * (docs/plans/2026-11-10-resolve-bulletproof.md).
 */

const hoisted = vi.hoisted(() => {
  class NotFoundError extends Error {}
  const objects = new Map<string, string>();
  const r2 = {
    get: async (k: string) => (objects.has(k) ? { text: async () => objects.get(k)! } : null),
    put: async (k: string, v: string) => void objects.set(k, v),
  };
  return {
    NotFoundError,
    notFound: vi.fn(() => {
      throw new NotFoundError('NEXT_NOT_FOUND');
    }),
    objects,
    r2,
    cf: { on: true },
  };
});
const headerBag = { value: new Map<string, string>() };

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerBag.value.get(k) ?? null }),
}));
vi.mock('next/navigation', () => ({ notFound: hoisted.notFound }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => {
    if (!hoisted.cf.on) throw new Error('not on cloudflare');
    return {
      env: { NEXT_INC_CACHE_R2_BUCKET: hoisted.r2 },
      ctx: { waitUntil: (p: Promise<unknown>) => p },
    };
  },
}));

const { getStoreOrNotFound, resolveStoreBySlug } = await import('../store-resolver');
const { StoreTemporarilyUnavailableError } = await import('../store-unavailable');
const cache = await import('../store-resolve-cache');
const { bumpEpochs, resetEpochMemo, storeVerdict, resetStoreVerdicts } =
  await import('../../../store-edge-cache');
const { isDemoStoreHost, resetDemoVerdicts, serveDemoEdge } =
  await import('../../../demo-edge-cache');
const { retryableUnavailable } = await import('../../../resolve-unavailable-edge');

const fetchMock = vi.fn();
let clock = 1_800_000_000_000;
let n = 0;
const uniq = (p: string) => `${p}-${n++}.example`;
const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const store = (host: string, status = 'active') =>
  json({
    success: true,
    data: { store: { id: `id-${host}`, slug: host.split('.')[0], status, template: 'qamar' } },
  });
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  hoisted.objects.clear();
  hoisted.notFound.mockClear();
  hoisted.cf.on = true;
  cache.__resetResolveCacheForTest();
  resetEpochMemo();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function resolveHost(host: string) {
  headerBag.value = new Map([['x-store-domain', host]]);
  return getStoreOrNotFound();
}

describe('L1/L2 fewer calls', () => {
  it('unknown host: a second request within the miss TTL makes ZERO API calls', async () => {
    const host = uniq('nobody');
    fetchMock.mockResolvedValue(json({ success: false, error: { code: 'STORE_NOT_FOUND' } }, 404));
    await expect(resolveHost(host)).rejects.toThrow('NEXT_NOT_FOUND');
    clock += 5_000;
    await expect(resolveHost(host)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a hit is shared across isolates through the durable copy (fresh window)', async () => {
    const host = uniq('shared');
    fetchMock.mockResolvedValueOnce(store(host));
    await resolveHost(host);
    await flush();
    cache.clearResolveMemory(); // a new isolate
    clock += 20_000;
    expect((await resolveHost(host)).id).toBe(`id-${host}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent misses in one isolate share one API call', async () => {
    const host = uniq('burst');
    fetchMock.mockResolvedValue(store(host));
    await Promise.all([resolveHost(host), resolveHost(host), resolveHost(host)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the resolve fetch bypasses the Next data cache (its tag purge cannot reach it)', async () => {
    const host = uniq('nocache');
    fetchMock.mockResolvedValue(store(host));
    await resolveHost(host);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(fetchMock.mock.calls[0][1].next).toBeUndefined();
  });
});

describe('L4 stale-if-error', () => {
  it('429 from the API + a stale copy -> the page renders from the stale copy', async () => {
    const host = uniq('stale');
    fetchMock.mockResolvedValueOnce(store(host));
    await resolveHost(host);
    await flush();
    clock += 10 * 60_000; // far past the fresh window
    fetchMock.mockResolvedValue(json({}, 429));
    const s = await resolveHost(host);
    expect(s.id).toBe(`id-${host}`);
    expect(hoisted.notFound).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2); // no retry when a stale copy exists
  });

  it('a new isolate serves the durable stale copy on a 5xx', async () => {
    const host = uniq('durable');
    fetchMock.mockResolvedValueOnce(store(host));
    await resolveHost(host);
    await flush();
    cache.clearResolveMemory();
    clock += 3 * 60 * 60_000;
    fetchMock.mockResolvedValue(json({}, 502));
    expect((await resolveHost(host)).id).toBe(`id-${host}`);
  });

  it('a purge newer than the copy forbids the stale copy (NEVER-stale status): unavailable, not the old store', async () => {
    const host = uniq('purged');
    fetchMock.mockResolvedValueOnce(store(host));
    await resolveHost(host);
    await flush();
    clock += 5_000;
    await bumpEpochs(hoisted.r2, [`store-domain:${host}`], clock);
    clock += 3_000;
    fetchMock.mockResolvedValue(json({}, 429));
    await expect(resolveHost(host)).rejects.toBeInstanceOf(StoreTemporarilyUnavailableError);
  });
});

describe('L5 no copy at all', () => {
  it('429 + no stale -> one retry, then StoreTemporarilyUnavailableError; nothing cached', async () => {
    const host = uniq('cold');
    fetchMock.mockResolvedValue(json({}, 429));
    await expect(resolveHost(host)).rejects.toBeInstanceOf(StoreTemporarilyUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...hoisted.objects.keys()].filter(k => k.startsWith('resolve-lkg/'))).toEqual([]);
    // the transient answer was not remembered: the API recovering is seen at once
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(store(host));
    expect((await resolveHost(host)).id).toBe(`id-${host}`);
  });

  it('a definitive 404 is never retried', async () => {
    fetchMock.mockResolvedValue(json({ success: false }, 404));
    await expect(resolveHost(uniq('gone'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the edge turns the store-unavailable 500 into 503 + Retry-After, no-store', async () => {
    const res = await retryableUnavailable(
      new Response('<html>…"digest":"STORE_TEMPORARILY_UNAVAILABLE"…</html>', {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const other = await retryableUnavailable(
      new Response('<html>boom</html>', { status: 500, headers: { 'content-type': 'text/html' } })
    );
    expect(other.status).toBe(500);
    expect(await other.text()).toBe('<html>boom</html>');
  });

  it('serveDemoEdge answers 503 for it and stores nothing in the edge cache', async () => {
    const put = vi.fn();
    const edgeCache = { match: vi.fn(async () => undefined), put };
    const res = await serveDemoEdge(
      new Request('https://storedemo.ebda.app/'),
      { waitUntil: () => {} },
      async () =>
        new Response('"digest":"STORE_TEMPORARILY_UNAVAILABLE"', {
          status: 500,
          headers: { 'content-type': 'text/html' },
        }),
      async () => true,
      'build-1',
      edgeCache
    );
    expect(res.status).toBe(503);
    expect(put).not.toHaveBeenCalled();
  });
});

describe('NEVER-stale invalidation reaches every layer', () => {
  it('suspend: the purge epoch makes the next request refetch and see the suspension (memory + durable)', async () => {
    const host = uniq('suspend');
    fetchMock.mockResolvedValueOnce(store(host));
    expect((await resolveHost(host)).status).toBe('active');
    await flush();
    clock += 5_000;
    await bumpEpochs(hoisted.r2, [`store-domain:${host}`], clock); // API: suspend -> bustStoreCaches
    clock += 3_000; // past the 2 s epoch memo
    fetchMock.mockResolvedValueOnce(store(host, 'suspended'));
    expect((await resolveHost(host)).status).toBe('suspended');
    cache.clearResolveMemory(); // another isolate reading the durable copy
    expect((await resolveHost(host)).status).toBe('suspended');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('domain removed: the store-id epoch invalidates the OLD host copy -> 404', async () => {
    const host = uniq('removed');
    fetchMock.mockResolvedValueOnce(store(host));
    await resolveHost(host);
    await flush();
    clock += 5_000;
    await bumpEpochs(hoisted.r2, [`layout:id-${host}`], clock); // bustStoreCaches always sends layout:<storeId>
    clock += 3_000;
    fetchMock.mockResolvedValueOnce(json({ success: false }, 404));
    await expect(resolveHost(host)).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('domain added: a negative copy is dropped by the new host purge', async () => {
    const host = uniq('added');
    fetchMock.mockResolvedValueOnce(json({ success: false }, 404));
    await expect(resolveHost(host)).rejects.toThrow('NEXT_NOT_FOUND');
    clock += 5_000;
    await bumpEpochs(hoisted.r2, [`store-domain:${host}`], clock);
    clock += 3_000;
    fetchMock.mockResolvedValueOnce(store(host));
    expect((await resolveHost(host)).id).toBe(`id-${host}`);
  });

  it('slug path: a store-slug purge reaches the slug cache', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ success: true, data: { id: 'id-s', slug: 'shopx', status: 'active' } })
    );
    await resolveStoreBySlug('shopx');
    clock += 5_000;
    await bumpEpochs(hoisted.r2, ['store-slug:shopx'], clock);
    clock += 3_000;
    fetchMock.mockResolvedValueOnce(json({}, 404));
    expect(await resolveStoreBySlug('shopx')).toBeNull();
  });

  it('without R2 (next start / dev) the memory window stays short (8 s hit)', async () => {
    hoisted.cf.on = false;
    const host = uniq('local');
    fetchMock.mockResolvedValue(store(host));
    await resolveHost(host);
    clock += 9_000;
    await resolveHost(host);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('alert + edge verdicts', () => {
  it('fires one alert per window at the threshold', () => {
    const alert = vi.fn();
    cache.__resetResolveCacheForTest(alert);
    for (let i = 0; i < 25; i++) cache.noteResolveFailure(clock, 'HTTP 429');
    expect(alert).toHaveBeenCalledTimes(1);
    cache.noteResolveFailure(clock + cache.ALERT_WINDOW_MS, 'HTTP 429');
    for (let i = 0; i < cache.ALERT_THRESHOLD; i++)
      cache.noteResolveFailure(clock + cache.ALERT_WINDOW_MS, 'x');
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('storeVerdict keeps the last good verdict on a 429 (does not flip to "not a store")', async () => {
    resetStoreVerdicts();
    const f = vi.fn().mockResolvedValueOnce(store('v.example'));
    expect((await storeVerdict('v.example', 'https://api', f as never, 0)).ok).toBe(true);
    f.mockResolvedValueOnce(json({}, 429));
    expect((await storeVerdict('v.example', 'https://api', f as never, 61_000)).ok).toBe(true);
    f.mockResolvedValueOnce(json({}, 404));
    expect((await storeVerdict('v.example', 'https://api', f as never, 130_000)).ok).toBe(false);
  });

  it('isDemoStoreHost keeps the last verdict on a network error', async () => {
    resetDemoVerdicts();
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { store: { isDemo: true, status: 'active' } } }));
    expect(await isDemoStoreHost('d.example', 'https://api', f as never, 0)).toBe(true);
    f.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await isDemoStoreHost('d.example', 'https://api', f as never, 301_000)).toBe(true);
  });
});
