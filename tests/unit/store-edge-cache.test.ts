// Ruling STORE-EDGE-1 (SEO-2 / P14): real store HTML from the edge, purged per store by an R2 epoch.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  STORE_EDGE_FRESH_S,
  bumpEpochs,
  epochKeysForTag,
  parseAllowlist,
  serveStoreEdge,
  storeEdgeKey,
  storeVerdict,
  resetStoreVerdicts,
  type CacheLike,
  type R2Like,
  type StoreEdgeDeps,
} from '../../apps/web/store-edge-cache';

const HOST = 'shop-a.ebda.app';
const OTHER = 'shop-b.ebda.app';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const req = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(url, { method, headers: { accept: 'text/html', ...headers } });

class MapCache implements CacheLike {
  readonly m = new Map<string, Response>();
  async match(k: string) {
    return this.m.get(k)?.clone();
  }
  async put(k: string, r: Response) {
    this.m.set(k, r);
  }
}
class MapR2 implements R2Like {
  readonly m = new Map<string, string>();
  fail = false;
  async get(k: string) {
    if (this.fail) throw new Error('r2 down');
    const v = this.m.get(k);
    return v === undefined ? null : { text: async () => v };
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
}

let clock: number;
let cache: MapCache;
let r2: MapR2;
let renders: number;
let page: string;
const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
const idOf = (host: string) => (host === HOST ? ID_A : ID_B);
const deps = (allow = parseAllowlist(`${HOST},${OTHER}`)): StoreEdgeDeps => ({
  allow,
  r2,
  cache,
  verdict: async host => ({ ok: true, id: idOf(host) }),
  now: () => clock,
});
const origin = async () => {
  renders++;
  return new Response(page, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
};
async function get(url = `https://${HOST}/`, headers: Record<string, string> = {}, d = deps()) {
  const res = await serveStoreEdge(req(url, headers), ctx, origin, d);
  await Promise.all(waits.splice(0));
  return { state: res.headers.get('x-store-edge'), body: await res.text(), res };
}

beforeEach(() => {
  clock = 10_000_000;
  cache = new MapCache();
  r2 = new MapR2();
  renders = 0;
  page = 'v1';
  waits.length = 0;
  resetStoreVerdicts();
});

describe('switch: nothing changes until a host is listed', () => {
  it('empty allowlist, unlisted host and a missing bucket all go straight to the origin', async () => {
    expect(storeEdgeKey(req(`https://${HOST}/`), parseAllowlist(''))).toBeNull();
    expect(storeEdgeKey(req(`https://${HOST}/`), parseAllowlist(undefined))).toBeNull();
    expect(storeEdgeKey(req('https://unlisted.ebda.app/'), parseAllowlist(HOST))).toBeNull();
    const res = await serveStoreEdge(req(`https://${HOST}/`), ctx, origin, {
      ...deps(),
      r2: undefined,
    });
    expect(res.headers.get('x-store-edge')).toBeNull();
    expect(cache.m.size).toBe(0);
  });
  it('the allowlist takes exact hosts only (no wildcard, no junk)', () => {
    expect([...parseAllowlist('*.ebda.app, Shop-A.ebda.app ,,a b,x_y')]).toEqual([
      'shop-a.ebda.app',
    ]);
  });
});

describe('hit path', () => {
  it('second read is a HIT with the stored body, the client is told private/no-store', async () => {
    expect((await get()).state).toBe('MISS');
    const hit = await get();
    expect(hit.state).toBe('HIT');
    expect(hit.body).toBe('v1');
    expect(hit.res.headers.get('cache-control')).toBe('private, no-store');
    expect(renders).toBe(1);
  });
  it('pages, hosts and the language cookie are separate entries', async () => {
    await get(`https://${HOST}/`);
    expect((await get(`https://${HOST}/products/abaya`)).state).toBe('MISS');
    expect((await get(`https://${OTHER}/`)).state).toBe('MISS');
    expect((await get(`https://${HOST}/`, { cookie: 'force-language=en' })).state).toBe('MISS');
    expect((await get(`https://${HOST}/`)).state).toBe('HIT');
  });
});

describe('write then read sees fresh data (purge = epoch)', () => {
  it('a product purge for the store invalidates every cached page of that store', async () => {
    await get(`https://${HOST}/`);
    await get(`https://${HOST}/products/abaya`);
    clock += 5_000;
    page = 'v2'; // price edited, then the API purges products:<id>
    await bumpEpochs(r2, [`products:${ID_A}`, `categories:${ID_A}`, `bundles:${ID_A}`], clock);
    clock += 5_000;
    const a = await get(`https://${HOST}/`);
    const b = await get(`https://${HOST}/products/abaya`);
    expect([a.state, b.state, a.body, b.body]).toEqual(['MISS', 'MISS', 'v2', 'v2']);
  });
  it('a theme/layout/status purge by host or layout tag invalidates', async () => {
    for (const tag of [
      `layout:${ID_A}`,
      `store-domain:${HOST}`,
      'store-slug:shop-a',
      `pwa:${ID_A}`,
    ]) {
      cache = new MapCache();
      await get();
      clock += 5_000;
      await bumpEpochs(r2, [tag], clock);
      clock += 5_000;
      expect((await get()).state, tag).toBe('MISS');
    }
  });
  it('another store purge leaves this store cached; an unmapped tag clears everything', async () => {
    await get();
    clock += 5_000;
    await bumpEpochs(r2, [`products:${ID_B}`], clock);
    clock += 5_000;
    expect((await get()).state).toBe('HIT');
    await bumpEpochs(r2, ['something-new:xyz'], clock);
    clock += 5_000;
    expect((await get()).state).toBe('MISS');
  });
  it('a purge that lands WHILE the page renders makes that copy invalid, never wrongly valid', async () => {
    const racing = async () => {
      renders++;
      // the purge arrives after the render started, before it is stored
      await bumpEpochs(r2, [`products:${ID_A}`], clock + 500);
      return new Response('old', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    await serveStoreEdge(req(`https://${HOST}/`), ctx, racing, deps());
    await Promise.all(waits.splice(0));
    clock += 100;
    page = 'new';
    const next = await get();
    expect(next.state).toBe('MISS');
    expect(next.body).toBe('new');
  });
  it('an unreadable epoch store fails closed to the origin', async () => {
    await get();
    r2.fail = true;
    const r = await get();
    expect(r.state).not.toBe('HIT');
    expect(renders).toBe(2);
  });
});

describe('windows', () => {
  it('fresh then stale-with-refresh then expired, epoch checked on the stale copy too', async () => {
    await get();
    clock += (STORE_EDGE_FRESH_S + 1) * 1000;
    page = 'v2';
    const stale = await get();
    expect(stale.state).toBe('STALE');
    expect(stale.body).toBe('v1');
    expect(renders).toBe(2); // background refresh
    clock += 1_000;
    expect((await get()).body).toBe('v2');
    clock += 700_000;
    expect((await get()).state).toBe('MISS');
  });
  it('a stale copy older than a purge is not served', async () => {
    await get();
    clock += (STORE_EDGE_FRESH_S + 1) * 1000;
    await bumpEpochs(r2, [`products:${ID_A}`], clock);
    clock += 5_000;
    expect((await get()).state).toBe('MISS');
  });
});

describe('what is never cached', () => {
  it.each([
    ['any other cookie', `https://${HOST}/`, { cookie: 'force-cookie-consent=1' }],
    ['language cookie plus another', `https://${HOST}/`, { cookie: 'force-language=ar; x=1' }],
    ['authorization', `https://${HOST}/`, { authorization: 'Bearer x' }],
    ['a query string', `https://${HOST}/?_preview=1`, {}],
    ['a paging query', `https://${HOST}/products?page=2`, {}],
    ['rsc request', `https://${HOST}/`, { rsc: '1' }],
    ['prefetch', `https://${HOST}/`, { 'next-router-prefetch': '1' }],
    ['spoofed host header', `https://${HOST}/`, { 'x-forwarded-host': OTHER }],
    ['checkout', `https://${HOST}/checkout`, {}],
    ['cart', `https://${HOST}/cart`, {}],
    ['api path', `https://${HOST}/api/x`, {}],
    ['double slash', `https://${HOST}//evil`, {}],
    ['non-html accept', `https://${HOST}/`, { accept: 'application/json' }],
  ])('%s bypasses', async (_n, url, headers) => {
    expect(
      storeEdgeKey(req(url, headers as Record<string, string>), parseAllowlist(HOST))
    ).toBeNull();
  });
  it('POST, upper-case host and a port bypass', () => {
    const a = parseAllowlist(HOST);
    expect(storeEdgeKey(req(`https://${HOST}/`, {}, 'POST'), a)).toBeNull();
    expect(storeEdgeKey(req(`https://${HOST}:8443/`), a)).toBeNull();
  });
  it('Set-Cookie, non-200 and non-HTML responses are not stored; a failing verdict stores nothing', async () => {
    const d = deps();
    for (const res of [
      () =>
        new Response('x', {
          status: 200,
          headers: { 'content-type': 'text/html', 'set-cookie': 'a=b' },
        }),
      () => new Response('x', { status: 404, headers: { 'content-type': 'text/html' } }),
      () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]) {
      await serveStoreEdge(req(`https://${HOST}/`), ctx, async () => res(), d);
    }
    await serveStoreEdge(req(`https://${HOST}/`), ctx, origin, {
      ...d,
      verdict: async () => ({ ok: false }),
    });
    await serveStoreEdge(req(`https://${HOST}/`), ctx, origin, {
      ...d,
      verdict: async () => {
        throw new Error('resolver down');
      },
    });
    await Promise.all(waits.splice(0));
    expect(cache.m.size).toBe(0);
  });
});

describe('purge tag mapping and the resolver verdict', () => {
  it('maps store tags to epoch keys', () => {
    expect(epochKeysForTag(`products:${ID_A}`)).toEqual([`id/${ID_A}`]);
    expect(epochKeysForTag('store-domain:WWW.Shop.com')).toEqual(['host/shop.com']);
    expect(epochKeysForTag('store-slug:shop-a')).toEqual(['host/shop-a.ebda.app']);
    expect(epochKeysForTag('store-domain:evil/../x')).toEqual(['all']);
    expect(epochKeysForTag('weird')).toEqual(['all']);
  });
  it('only an ACTIVE store passes, fails closed, and is remembered', async () => {
    let calls = 0;
    const f = (status: string) =>
      (async () => {
        calls++;
        return new Response(JSON.stringify({ data: { store: { id: ID_A, status } } }), {
          status: 200,
        });
      }) as unknown as typeof fetch;
    expect(await storeVerdict(HOST, 'https://api', f('active'))).toEqual({ ok: true, id: ID_A });
    expect(await storeVerdict(HOST, 'https://api', f('suspended'))).toEqual({ ok: true, id: ID_A }); // remembered 60 s
    expect(calls).toBe(1);
    resetStoreVerdicts();
    expect((await storeVerdict(HOST, 'https://api', f('suspended'))).ok).toBe(false);
    resetStoreVerdicts();
    const boom = (async () => {
      throw new Error('x');
    }) as unknown as typeof fetch;
    expect((await storeVerdict(HOST, 'https://api', boom)).ok).toBe(false);
  });
});
