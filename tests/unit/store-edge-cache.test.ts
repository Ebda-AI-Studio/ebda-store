// Ruling STORE-EDGE-1 (SEO-2 / P14): real store HTML from the edge, purged per store by an R2 epoch.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  STORE_EDGE_FRESH_S,
  STORE_EDGE_STALE_S,
  bumpEpochs,
  epochKeysForTag,
  parseAllowlist,
  serveStoreEdge,
  storeEdgeKey,
  storeVerdict,
  resetStoreVerdicts,
  resetEpochMemo,
  edgeAllowlistFromEnv,
  EPOCH_MEMO_MS,
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
/** A Worker version id (Ruling EDGE-BUILD-1): every stored entry lives under it. */
const BUILD = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_BUILD = 'bbbbbbbb-2222-4222-8222-222222222222';
const deps = (allow = parseAllowlist(`${HOST},${OTHER}`)): StoreEdgeDeps => ({
  allow,
  r2,
  cache,
  build: BUILD,
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
  resetEpochMemo();
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
    clock += (STORE_EDGE_STALE_S + 100) * 1000;
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
    expect(await storeVerdict(HOST, 'https://api', f('active'))).toEqual({
      ok: true,
      id: ID_A,
      defaultLanguage: 'ar',
    });
    expect((await storeVerdict(HOST, 'https://api', f('suspended'))).ok).toBe(true); // remembered 60 s
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

// ---------------------------------------------------------------------------------------------------------------
// S2-REVIVE (Ruling STORE-EDGE-2): the layer on for every store, the first-visitor language cookie, tracking params,
// coalescing, the epoch memo, the kill switch.
// ---------------------------------------------------------------------------------------------------------------
const ALL = parseAllowlist('all');
const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
const LANG_AR =
  'force-language=ar; Path=/; Expires=Tue, 09 Nov 2027 10:03:22 GMT; Max-Age=31536000; Secure; SameSite=lax';

describe('switches: all, none, off', () => {
  it('`all` keys every well-formed store host; `none`, empty and the OFF secret key nothing', () => {
    expect(storeEdgeKey(req('https://any-store.ebda.app/'), ALL)).toBe(
      'https://any-store.ebda.app/?__edge=store'
    );
    expect(storeEdgeKey(req('https://shop.example.com/ar'), ALL)).toBe(
      'https://shop.example.com/ar?__edge=store'
    );
    expect(storeEdgeKey(req('https://localhost/'), ALL)).toBeNull();
    expect(storeEdgeKey(req(`https://${HOST}/`), parseAllowlist('none'))).toBeNull();
    expect(edgeAllowlistFromEnv({ STOREFRONT_HTML_EDGE_HOSTS: 'all' }).size).toBe(1);
    expect(
      edgeAllowlistFromEnv({ STOREFRONT_HTML_EDGE_HOSTS: 'all', STOREFRONT_HTML_EDGE_OFF: '1' })
        .size
    ).toBe(0);
    expect(edgeAllowlistFromEnv({}).size).toBe(0);
  });
  it('`all` still stores nothing for a host the resolver does not vouch for (unknown / suspended / not a store)', async () => {
    const d = { ...deps(ALL), verdict: async () => ({ ok: false }) };
    await get('https://not-a-store.ebda.app/', {}, d);
    expect(cache.m.size).toBe(0);
  });
});

describe('cache key includes the store: no cross-tenant HTML', () => {
  it("the same path on two stores never serves one store the other one's page", async () => {
    page = 'store A page';
    await get(`https://${HOST}/ar/products/abaya`, {}, deps(ALL));
    page = 'store B page';
    const b = await get(`https://${OTHER}/ar/products/abaya`, {}, deps(ALL));
    expect([b.state, b.body]).toEqual(['MISS', 'store B page']);
    const a = await get(`https://${HOST}/ar/products/abaya`, {}, deps(ALL));
    expect([a.state, a.body]).toEqual(['HIT', 'store A page']);
    expect([...cache.m.keys()].sort()).toEqual([
      `https://${HOST}/ar/products/abaya?__edge=store&__build=${BUILD}`,
      `https://${OTHER}/ar/products/abaya?__edge=store&__build=${BUILD}`,
    ]);
  });
});

describe('first visitor on a /ar|/en page (the viral path)', () => {
  const langOrigin = async (r: Request) => {
    renders++;
    const hasAr = (r.headers.get('cookie') ?? '') === 'force-language=ar';
    return html(page, hasAr ? {} : { 'set-cookie': LANG_AR });
  };
  const serve = async (url: string, headers: Record<string, string> = {}) => {
    const res = await serveStoreEdge(req(url, headers), ctx, langOrigin, deps(ALL));
    await Promise.all(waits.splice(0));
    return res;
  };
  it('a cookie-less render is stored without its cookie and re-issues it per visitor', async () => {
    const first = await serve(`https://${HOST}/ar`);
    expect(first.headers.get('x-store-edge')).toBe('MISS');
    expect(first.headers.get('set-cookie')).toContain('force-language=ar');
    const stored = cache.m.get(`https://${HOST}/ar?__edge=store&__build=${BUILD}`);
    expect(stored?.headers.get('set-cookie')).toBeNull();
    const second = await serve(`https://${HOST}/ar`);
    expect(second.headers.get('x-store-edge')).toBe('HIT');
    expect(second.headers.get('set-cookie')).toMatch(
      /^force-language=ar; Path=\/; Max-Age=31536000; Secure; SameSite=lax$/
    );
    const withCookie = await serve(`https://${HOST}/ar`, { cookie: 'force-language=ar' });
    expect(withCookie.headers.get('x-store-edge')).toBe('HIT');
    expect(withCookie.headers.get('set-cookie')).toBeNull();
    const otherLang = await serve(`https://${HOST}/ar`, { cookie: 'force-language=en' });
    expect(otherLang.headers.get('x-store-edge')).toBe('HIT');
    expect(otherLang.headers.get('set-cookie')).toContain('force-language=ar');
    expect(renders).toBe(1);
  });
  it('/en and /ar of one page are separate entries; the cookie is not part of a prefixed key', () => {
    expect(storeEdgeKey(req(`https://${HOST}/en/faq`, { cookie: 'force-language=ar' }), ALL)).toBe(
      `https://${HOST}/en/faq?__edge=store`
    );
    expect(storeEdgeKey(req(`https://${HOST}/faq`, { cookie: 'force-language=ar' }), ALL)).toBe(
      `https://${HOST}/faq?__edge=store&__lang=ar`
    );
  });
});

describe('no Set-Cookie / private / personalised response is ever cached', () => {
  it.each([
    ['a session cookie', { 'set-cookie': 'sid=abc; Path=/; HttpOnly' }],
    ['the language cookie plus another', { 'set-cookie': `${LANG_AR}, sid=abc; Path=/` }],
    ['the OTHER language cookie on an /ar page', { 'set-cookie': LANG_AR.replace('=ar', '=en') }],
  ])('a render that sets %s is served once and never stored', async (_n, headers) => {
    const res = await serveStoreEdge(
      req(`https://${HOST}/ar`),
      ctx,
      async () => html('private', headers as Record<string, string>),
      deps(ALL)
    );
    await Promise.all(waits.splice(0));
    expect(res.headers.get('x-store-edge')).toBeNull();
    expect(cache.m.size).toBe(0);
  });
  it.each([
    '/ar/checkout',
    '/en/cart',
    '/ar/account/orders',
    '/en/auth/login',
    '/ar/wishlist',
    '/en/search',
    '/ar/compare',
    '/ar/review/ord_123',
    '/en/unsubscribe',
    '/sms-unsubscribe',
    '/affiliate',
    '/ar/q/x',
  ])('%s bypasses with or without a language prefix', p => {
    expect(storeEdgeKey(req(`https://${HOST}${p}`), ALL)).toBeNull();
  });
  it('a request with an auth or consent cookie, or Authorization, bypasses even on /ar', () => {
    for (const headers of [
      { cookie: 'force-language=ar; token=x' },
      { cookie: 'force-cookie-consent=%7B%7D' },
      { authorization: 'Bearer x' },
    ])
      expect(storeEdgeKey(req(`https://${HOST}/ar`, headers), ALL)).toBeNull();
  });
});

describe('click-tracking parameters (social / ads links)', () => {
  it('are dropped from the key and from the render on a /ar|/en page; any other param bypasses', async () => {
    const url = `https://${HOST}/ar/products/abaya?utm_source=ig&fbclid=abc123&gclid=x`;
    expect(storeEdgeKey(req(url), ALL)).toBe(`https://${HOST}/ar/products/abaya?__edge=store`);
    let seen = '';
    await serveStoreEdge(
      req(url),
      ctx,
      async r => {
        seen = r.url;
        return html('p');
      },
      deps(ALL)
    );
    await Promise.all(waits.splice(0));
    expect(seen).toBe(`https://${HOST}/ar/products/abaya`);
    expect(storeEdgeKey(req(`https://${HOST}/ar/products?page=2&utm_source=ig`), ALL)).toBeNull();
    expect(storeEdgeKey(req(`https://${HOST}/ar?look=x`), ALL)).toBeNull();
    // Unprefixed: the locale redirect needs the original query, so it is left alone.
    expect(storeEdgeKey(req(`https://${HOST}/?utm_source=ig`), ALL)).toBeNull();
  });
});

describe('coalescing: a spike after a purge renders once per isolate', () => {
  it('concurrent misses for one key share one render', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => (release = r));
    const slow = async () => {
      renders++;
      await gate;
      return html('one render');
    };
    const all = Array.from({ length: 5 }, () =>
      serveStoreEdge(req(`https://${HOST}/ar`), ctx, slow, deps(ALL))
    );
    release();
    const res = await Promise.all(all);
    await Promise.all(waits.splice(0));
    expect(renders).toBe(1);
    expect(await Promise.all(res.map(r => r.text()))).toEqual(Array(5).fill('one render'));
    expect(res.map(r => r.headers.get('x-store-edge')).sort()).toEqual([
      'COALESCED',
      'COALESCED',
      'COALESCED',
      'COALESCED',
      'MISS',
    ]);
  });
  it('waiters on a render that cannot be stored render for themselves (never share a private page)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => (release = r));
    const priv = async () => {
      renders++;
      await gate;
      return html('mine', { 'set-cookie': 'sid=1' });
    };
    const all = Array.from({ length: 3 }, () =>
      serveStoreEdge(req(`https://${HOST}/ar`), ctx, priv, deps(ALL))
    );
    release();
    await Promise.all(all);
    expect(renders).toBe(3);
  });
});

describe('epoch memo (residual 3: another isolate may serve a pre-purge copy for <= 2 s)', () => {
  it('a purge recorded by ANOTHER isolate is honoured once the memo expires; this isolate honours its own at once', async () => {
    await get(`https://${HOST}/`, {}, deps(ALL));
    clock += 5_000;
    expect((await get(`https://${HOST}/`, {}, deps(ALL))).state).toBe('HIT'); // epochs now memoised
    // another isolate's purge: written straight to R2, this isolate's memo not cleared
    r2.m.set(`html-epoch/id/${ID_A}`, String(clock));
    clock += 1_500;
    expect((await get(`https://${HOST}/`, {}, deps(ALL))).state).toBe('HIT');
    clock += EPOCH_MEMO_MS;
    expect((await get(`https://${HOST}/`, {}, deps(ALL))).state).toBe('MISS');
    clock += 5_000;
    await get(`https://${HOST}/`, {}, deps(ALL));
    clock += 5_000;
    await bumpEpochs(r2, [`products:${ID_A}`], clock);
    clock += 1_500;
    expect((await get(`https://${HOST}/`, {}, deps(ALL))).state).toBe('MISS');
  });
});

describe('Ruling STORE-EDGE-3: the demo layer and this layer share caches.default without colliding', () => {
  it('a demo host: the demo layer hits from the second request on, both layers keep their own entry', async () => {
    const { serveDemoEdge, resetDemoVerdicts } = await import('../../apps/web/demo-edge-cache');
    resetDemoVerdicts();
    const shared = new MapCache();
    const demoHost = 'storedemo.ebda.app';
    const storeDeps = { ...deps(ALL), cache: shared };
    let n = 0;
    const next = async () => (n++, html('demo page', { 'set-cookie': LANG_AR }));
    const browse = async () => {
      const c: Promise<unknown>[] = [];
      const res = await serveDemoEdge(
        req(`https://${demoHost}/ar`),
        { waitUntil: p => void c.push(p) },
        r => serveStoreEdge(r, { waitUntil: p => void c.push(p) }, next, storeDeps),
        async () => true,
        BUILD,
        shared as never
      );
      await Promise.all(c);
      return res;
    };
    const first = await browse();
    const second = await browse();
    const third = await browse();
    expect(first.headers.get('x-demo-edge')).toBe('MISS');
    expect(second.headers.get('x-demo-edge')).toBe('HIT');
    expect(third.headers.get('x-demo-edge')).toBe('HIT');
    expect(n).toBe(1);
    expect([...shared.m.keys()].sort()).toEqual([
      `https://${demoHost}/ar?__build=${BUILD}`,
      `https://${demoHost}/ar?__edge=store&__build=${BUILD}`,
    ]);
  });
});

describe('Ruling STORE-EDGE-3: link previews and crawlers (Accept */* or none) are document requests', () => {
  it.each([
    ['*/*', true],
    ['', true],
    [null, true],
    ['text/html,application/xhtml+xml', true],
    ['application/json', false],
    ['image/avif,image/webp,*/*', false],
  ])('Accept %s -> eligible %s', (accept, ok) => {
    const headers: Record<string, string> = {};
    const r = new Request(`https://${HOST}/ar`, { headers });
    if (accept !== null) r.headers.set('accept', accept as string);
    expect(storeEdgeKey(r, ALL) !== null).toBe(ok);
  });
});

describe('Ruling EDGE-BUILD-1: a copy rendered by one build is never served by another', () => {
  const of = (build: string | null): StoreEdgeDeps => ({ ...deps(ALL), build });
  it('build B misses on the entry build A stored a moment ago, and renders its own page', async () => {
    page = '<script src="/_next/static/chunks/old-build.js"></script>';
    expect((await get(`https://${HOST}/ar`, {}, of(BUILD))).state).toBe('MISS');
    clock += 1_000;
    const sameBuild = await get(`https://${HOST}/ar`, {}, of(BUILD));
    expect([sameBuild.state, sameBuild.body]).toEqual(['HIT', page]);

    // The deploy: same store, same path, no store write (so no epoch moved), one second later.
    page = '<script src="/_next/static/chunks/new-build.js"></script>';
    clock += 1_000;
    const afterDeploy = await get(`https://${HOST}/ar`, {}, of(OTHER_BUILD));
    expect(afterDeploy.state).toBe('MISS');
    expect(afterDeploy.body).toContain('new-build.js');
    expect(afterDeploy.body).not.toContain('old-build.js');
    expect([...cache.m.keys()].sort()).toEqual([
      `https://${HOST}/ar?__edge=store&__build=${BUILD}`,
      `https://${HOST}/ar?__edge=store&__build=${OTHER_BUILD}`,
    ]);
  });
  it('the stale window never reaches across a deploy either', async () => {
    page = 'old-build';
    await get(`https://${HOST}/ar`, {}, of(BUILD));
    clock += (STORE_EDGE_FRESH_S + 5) * 1000;
    expect((await get(`https://${HOST}/ar`, {}, of(BUILD))).state).toBe('STALE');
    page = 'new-build';
    const next = await get(`https://${HOST}/ar`, {}, of(OTHER_BUILD));
    expect([next.state, next.body]).toEqual(['MISS', 'new-build']);
  });
  it('a store purge still reaches every build (the epoch is per store, not per build)', async () => {
    await get(`https://${HOST}/ar`, {}, of(BUILD));
    await get(`https://${HOST}/ar`, {}, of(OTHER_BUILD));
    clock += 5_000;
    await bumpEpochs(r2, [`products:${ID_A}`], clock);
    clock += 1_500;
    expect((await get(`https://${HOST}/ar`, {}, of(BUILD))).state).toBe('MISS');
    expect((await get(`https://${HOST}/ar`, {}, of(OTHER_BUILD))).state).toBe('MISS');
  });
  it('no build id: nothing is read and nothing is stored', async () => {
    await get(`https://${HOST}/ar`, {}, of(BUILD));
    const before = [...cache.m.keys()];
    const a = await get(`https://${HOST}/ar`, {}, of(null));
    const b = await get(`https://${HOST}/ar`, {}, of(null));
    expect([a.state, b.state]).toEqual([null, null]);
    expect(renders).toBe(3);
    expect([...cache.m.keys()]).toEqual(before);
  });
  it('an entry stored before this ruling (no build in its key) is never read', async () => {
    page = 'pre-ruling';
    await get(`https://${HOST}/ar`, {}, of(BUILD));
    const key = `https://${HOST}/ar?__edge=store`;
    cache.m.set(key, cache.m.get(`${key}&__build=${BUILD}`)!.clone());
    cache.m.delete(`${key}&__build=${BUILD}`);
    page = 'new-build';
    clock += 1_000;
    const r = await get(`https://${HOST}/ar`, {}, of(BUILD));
    expect([r.state, r.body]).toEqual(['MISS', 'new-build']);
  });
});
