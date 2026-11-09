// Ruling DEMO-EDGE-1, hardened after the #128 security review. One negative control per finding:
//  1 per-visitor state (any cookie / consent / auth is never cached),
//  2 scope (a real store, spoofed Host-ish headers, case, trailing dot, port, custom domain are never cached),
//  3 parser differential (unknown/malformed/repeated look, extra params, odd paths never get a key).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEMO_EDGE_FRESH_S,
  demoEdgeKey,
  isDemoStoreHost,
  resetDemoVerdicts,
  serveDemoEdge,
  DEMO_EDGE_CACHE_CONTROL,
} from '../../apps/web/demo-edge-cache';

const req = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(url, { method, headers: { accept: 'text/html', ...headers } });
const D = 'https://storedemo.ebda.app';
/** A Worker version id (Ruling EDGE-BUILD-1): every stored entry lives under it. */
const BUILD = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_BUILD = 'bbbbbbbb-2222-4222-8222-222222222222';

describe('finding 3: the key is built from a strict allowlist', () => {
  it('keys host + path + a built look only', () => {
    expect(demoEdgeKey(req(`${D}/categories?look=qamar.lookbook`))).toBe(
      `${D}/categories?look=qamar.lookbook`
    );
    expect(demoEdgeKey(req(`${D}/`))).toBe(`${D}/`);
  });
  it('look is part of the key', () => {
    expect(demoEdgeKey(req(`${D}/?look=qamar.lookbook`))).not.toBe(
      demoEdgeKey(req(`${D}/?look=qamar.vitrine`))
    );
  });
  it.each([
    ['unknown look', '/?look=qamar.nope'],
    ['malformed look', '/?look=qamar.lookbook%00'],
    ['look with junk suffix', '/?look=qamar.lookbook&x=1'],
    ['repeated look', '/?look=qamar.lookbook&look=qamar.vitrine'],
    ['empty look', '/?look='],
    ['unknown param', '/?utm_source=x'],
    ['preview param', '/?_preview=1'],
    ['draft param', '/?_layoutDraft=t'],
    ['token param', '/?token=abc'],
    ['double slash', '//evil'],
    ['api path', '/api/x'],
    ['checkout path', '/checkout'],
    ['encoded query smuggling', '/?look=qamar.lookbook%26x%3D1'],
    ['unsafe path chars', '/a;b'],
  ])('never keys %s', (_n, path) => {
    expect(demoEdgeKey(req(`${D}${path}`))).toBeNull();
  });
});

describe('finding 3: the key path is the exact path the origin receives', () => {
  it('dot segments are normalised by the URL parser before the key is built (key == origin path)', () => {
    for (const p of ['/a/../b', '/a/%2e%2e/b']) {
      const r = req(`${D}${p}`);
      expect(demoEdgeKey(r)).toBe(`${D}${new URL(r.url).pathname}`);
      expect(new URL(r.url).pathname).toBe('/b');
    }
  });
});

describe('finding 2: scope is the exact canonical demo host', () => {
  it.each([
    'https://real-shop.ebda.app/',
    'https://demo-merchant.ebda.app/',
    'https://ebda.app/',
    'https://shop.example.com/',
    'https://storedemo.ebda.app./',
    'https://STOREDEMO.ebda.app/',
    'https://storedemo.ebda.app:8443/',
    'https://storedemo.ebda.app.evil.com/',
    'https://evil-storedemo.ebda.app/',
    'https://x.storedemo.ebda.app/',
    'http://storedemo.ebda.app/',
  ])('never keys %s', url => {
    // URL parsing lower-cases the host; the uppercase case proves the parser cannot be used to dodge the check either way.
    const k = demoEdgeKey(req(url));
    if (url === 'https://STOREDEMO.ebda.app/') expect(k).toBe(`${D}/`);
    else expect(k).toBeNull();
  });
  it.each(['x-forwarded-host', 'forwarded', 'x-original-host', 'x-store-domain'])(
    'a spoofed %s header makes the request ineligible',
    h => {
      expect(demoEdgeKey(req(`${D}/`, { [h]: 'real-shop.ebda.app' }))).toBeNull();
    }
  );
  it('a real store that the resolver does not call demo is never cached, even on a demo-looking host', async () => {
    resetDemoVerdicts();
    const f = async () =>
      new Response(JSON.stringify({ data: { store: { isDemo: false, status: 'active' } } }));
    expect(await isDemoStoreHost('storedemo.ebda.app', 'https://api', f as typeof fetch)).toBe(
      false
    );
  });
  it('the resolver check fails closed (error, non-200, suspended, malformed)', async () => {
    for (const f of [
      async () => {
        throw new Error('net');
      },
      async () => new Response('{}', { status: 500 }),
      async () =>
        new Response(JSON.stringify({ data: { store: { isDemo: true, status: 'suspended' } } })),
      async () => new Response('not json'),
    ]) {
      resetDemoVerdicts();
      expect(await isDemoStoreHost('storedemo.ebda.app', 'https://api', f as typeof fetch)).toBe(
        false
      );
    }
  });
  it('an active isDemo store passes, and the verdict is remembered', async () => {
    resetDemoVerdicts();
    let calls = 0;
    const f = async () => {
      calls++;
      return new Response(JSON.stringify({ data: { store: { isDemo: true, status: 'active' } } }));
    };
    expect(await isDemoStoreHost('storedemo.ebda.app', 'https://api', f as typeof fetch)).toBe(
      true
    );
    expect(await isDemoStoreHost('storedemo.ebda.app', 'https://api', f as typeof fetch)).toBe(
      true
    );
    expect(calls).toBe(1);
  });
});

describe('language cookie is a keyed 2-way variant, nothing else', () => {
  it('force-language=ar|en alone is keyed apart from each other and from cookieless', () => {
    const ar = demoEdgeKey(req(`${D}/`, { cookie: 'force-language=ar' }));
    const en = demoEdgeKey(req(`${D}/`, { cookie: 'force-language=en' }));
    const none = demoEdgeKey(req(`${D}/`));
    expect(new Set([ar, en, none]).size).toBe(3);
    expect(ar).toBeTruthy();
  });
});

describe('finding 1: no per-visitor state is ever cached', () => {
  it.each([
    ['consent cookie', { cookie: 'force-cookie-consent=granted' }],
    ['language cookie with a second cookie', { cookie: 'force-language=ar; _ga=1' }],
    ['language cookie with a bad value', { cookie: 'force-language=fr' }],
    ['language cookie with injected value', { cookie: 'force-language=ar%0d' }],
    ['draft cookie', { cookie: 'force-preview-draft=x' }],
    ['auth cookie', { cookie: 'token=abc' }],
    ['analytics cookie', { cookie: '_ga=1' }],
    ['authorization header', { authorization: 'Bearer x' }],
    ['rsc request', { rsc: '1' }],
    ['server action', { 'next-action': 'x' }],
    ['prefetch', { 'next-router-prefetch': '1' }],
    ['json accept', { accept: 'application/json' }],
  ])('never keys a request with %s', (_n, headers) => {
    expect(demoEdgeKey(req(`${D}/`, headers))).toBeNull();
  });
  it('two requests with different consent cookies never share a cache entry (both bypass)', async () => {
    const cache = fakeCache();
    let renders = 0;
    const origin = async () => (renders++, html());
    const c = ctx();
    for (const cookie of ['force-cookie-consent=granted', 'force-cookie-consent=denied'])
      await serveDemoEdge(req(`${D}/`, { cookie }), c, origin, async () => true, BUILD, cache);
    await c.settle();
    expect(renders).toBe(2);
    expect(cache.m.size).toBe(0);
  });
});

function fakeCache() {
  const m = new Map<string, Response>();
  return {
    m,
    match: async (k: RequestInfo | URL) => m.get(String(k))?.clone(),
    put: async (k: RequestInfo | URL, r: Response) => void m.set(String(k), r),
  };
}
const html = () =>
  new Response('<html>x</html>', {
    headers: { 'content-type': 'text/html', 'cache-control': 'private, no-store' },
  });
const ctx = () => {
  const p: Promise<unknown>[] = [];
  return { waitUntil: (x: Promise<unknown>) => void p.push(x), settle: () => Promise.all(p) };
};
const yes = async () => true;

describe('serveDemoEdge', () => {
  beforeEach(() => resetDemoVerdicts());
  it('MISS then HIT on a verified demo host, with the public edge Cache-Control', async () => {
    const cache = fakeCache();
    let renders = 0;
    const origin = async () => (renders++, html());
    const c1 = ctx();
    const r1 = await serveDemoEdge(req(`${D}/?look=qamar.lookbook`), c1, origin, yes, BUILD, cache);
    await c1.settle();
    expect(r1.headers.get('x-demo-edge')).toBe('MISS');
    expect(r1.headers.get('cache-control')).toBe('private, no-store');
    expect(DEMO_EDGE_CACHE_CONTROL).toBe('private, no-store');
    expect(r1.headers.get('x-demo-cache')).toBe('miss');
    const r2 = await serveDemoEdge(
      req(`${D}/?look=qamar.lookbook`),
      ctx(),
      origin,
      yes,
      BUILD,
      cache
    );
    expect(r2.headers.get('x-demo-edge')).toBe('HIT');
    expect(r2.headers.get('x-demo-cache')).toBe('hit');
    expect(r2.headers.get('cache-control')).toBe('private, no-store');
    expect(renders).toBe(1);
  });
  it('a HIT or STALE never waits for the resolver (entries exist only after a passed verdict)', async () => {
    const cache = fakeCache();
    const c = ctx();
    await serveDemoEdge(req(`${D}/x`), c, async () => html(), yes, BUILD, cache);
    await c.settle();
    let asked = 0;
    const r = await serveDemoEdge(
      req(`${D}/x`),
      ctx(),
      async () => html(),
      async () => (asked++, false),
      BUILD,
      cache
    );
    expect(r.headers.get('x-demo-edge')).toBe('HIT');
    expect(asked).toBe(0);
  });
  it('a demo-looking host the resolver rejects is rendered live and never stored', async () => {
    const cache = fakeCache();
    const c = ctx();
    const r = await serveDemoEdge(
      req(`${D}/`),
      c,
      async () => html(),
      async () => false,
      BUILD,
      cache
    );
    await c.settle();
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(cache.m.size).toBe(0);
  });
  it('a real merchant store is untouched: origin response returned verbatim, nothing stored', async () => {
    const cache = fakeCache();
    const r = await serveDemoEdge(
      req('https://real-shop.ebda.app/'),
      ctx(),
      async () => html(),
      yes,
      BUILD,
      cache
    );
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('x-demo-edge')).toBeNull();
    expect(cache.m.size).toBe(0);
  });
  it('does not store a non-200 or a Set-Cookie response', async () => {
    const cache = fakeCache();
    const c = ctx();
    await serveDemoEdge(
      req(`${D}/a`),
      c,
      async () => new Response('x', { status: 404, headers: { 'content-type': 'text/html' } }),
      yes,
      BUILD,
      cache
    );
    await serveDemoEdge(
      req(`${D}/b`),
      c,
      async () =>
        new Response('x', { headers: { 'content-type': 'text/html', 'set-cookie': 'a=b' } }),
      yes,
      BUILD,
      cache
    );
    await c.settle();
    expect(cache.m.size).toBe(0);
  });
});

describe('first cookie-less visitor on a /ar|/en page (Ruling STORE-EDGE-2, measured 2.95 s uncached 2026-11-09)', () => {
  it('the URL-locale language cookie no longer blocks storage; it is stripped and re-issued per visitor', async () => {
    resetDemoVerdicts();
    const cache = fakeCache();
    let renders = 0;
    const origin = async () => {
      renders++;
      return new Response('<html>ar</html>', {
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'force-language=ar; Path=/; Max-Age=31536000; Secure; SameSite=lax',
        },
      });
    };
    const c = ctx();
    await serveDemoEdge(req(`${D}/ar`), c, origin, yes, BUILD, cache);
    await c.settle();
    expect(cache.m.get(`${D}/ar?__build=${BUILD}`)?.headers.get('set-cookie')).toBeNull();
    const hit = await serveDemoEdge(req(`${D}/ar`), ctx(), origin, yes, BUILD, cache);
    expect(hit.headers.get('x-demo-edge')).toBe('HIT');
    expect(hit.headers.get('set-cookie')).toContain('force-language=ar');
    const cookied = await serveDemoEdge(
      req(`${D}/ar`, { cookie: 'force-language=ar' }),
      ctx(),
      origin,
      yes,
      BUILD,
      cache
    );
    expect(cookied.headers.get('x-demo-edge')).toBe('HIT');
    expect(cookied.headers.get('set-cookie')).toBeNull();
    expect(renders).toBe(1);
  });
  it('a session cookie on an /ar page is still never stored', async () => {
    const cache = fakeCache();
    const c = ctx();
    await serveDemoEdge(
      req(`${D}/ar`),
      c,
      async () =>
        new Response('x', {
          headers: { 'content-type': 'text/html', 'set-cookie': 'sid=1; Path=/' },
        }),
      yes,
      BUILD,
      cache
    );
    await c.settle();
    expect(cache.m.size).toBe(0);
  });
});

describe('Ruling EDGE-BUILD-1: a copy rendered by one build is never served by another', () => {
  beforeEach(() => resetDemoVerdicts());
  const pageOf = (chunk: string) => async () =>
    new Response(`<html><script src="/_next/static/chunks/${chunk}.js"></script></html>`, {
      headers: { 'content-type': 'text/html' },
    });
  it('build B misses on the entry build A stored, and renders its own page', async () => {
    const cache = fakeCache();
    const c = ctx();
    await serveDemoEdge(req(`${D}/en`), c, pageOf('old-build'), yes, BUILD, cache);
    await c.settle();
    const sameBuild = await serveDemoEdge(
      req(`${D}/en`),
      ctx(),
      pageOf('never'),
      yes,
      BUILD,
      cache
    );
    expect(sameBuild.headers.get('x-demo-edge')).toBe('HIT');
    expect(await sameBuild.text()).toContain('old-build.js');

    const c2 = ctx();
    const afterDeploy = await serveDemoEdge(
      req(`${D}/en`),
      c2,
      pageOf('new-build'),
      yes,
      OTHER_BUILD,
      cache
    );
    await c2.settle();
    expect(afterDeploy.headers.get('x-demo-edge')).toBe('MISS');
    const body = await afterDeploy.text();
    expect(body).toContain('new-build.js');
    expect(body).not.toContain('old-build.js');
    expect([...cache.m.keys()].sort()).toEqual([
      `${D}/en?__build=${BUILD}`,
      `${D}/en?__build=${OTHER_BUILD}`,
    ]);
  });
  it('the 24 h stale window never reaches across a deploy (the 2026-11-09 /en failure)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      const cache = fakeCache();
      const c = ctx();
      await serveDemoEdge(req(`${D}/en`), c, pageOf('old-build'), yes, BUILD, cache);
      await c.settle();
      // Past the fresh window: the SAME build may serve it stale...
      vi.setSystemTime(1_800_000_000_000 + (DEMO_EDGE_FRESH_S + 60) * 1000);
      const c1 = ctx();
      const stale = await serveDemoEdge(req(`${D}/en`), c1, pageOf('old-build'), yes, BUILD, cache);
      await c1.settle();
      expect(stale.headers.get('x-demo-edge')).toBe('STALE');
      // ...the next build never does.
      const c2 = ctx();
      const next = await serveDemoEdge(
        req(`${D}/en`),
        c2,
        pageOf('new-build'),
        yes,
        OTHER_BUILD,
        cache
      );
      await c2.settle();
      expect(next.headers.get('x-demo-edge')).toBe('MISS');
      expect(await next.text()).not.toContain('old-build.js');
    } finally {
      vi.useRealTimers();
    }
  });
  it('a rollback to build A reads build A entries again, never build B ones', async () => {
    const cache = fakeCache();
    for (const [build, chunk] of [
      [BUILD, 'a'],
      [OTHER_BUILD, 'b'],
    ] as const) {
      const c = ctx();
      await serveDemoEdge(req(`${D}/ar`), c, pageOf(chunk), yes, build, cache);
      await c.settle();
    }
    const back = await serveDemoEdge(req(`${D}/ar`), ctx(), pageOf('never'), yes, BUILD, cache);
    expect(back.headers.get('x-demo-edge')).toBe('HIT');
    expect(await back.text()).toContain('/chunks/a.js');
  });
  it('no build id: nothing is read and nothing is stored', async () => {
    const cache = fakeCache();
    cache.m.set(`${D}/en`, await pageOf('legacy-entry')());
    let renders = 0;
    const origin = async () => (renders++, html());
    const c = ctx();
    for (let i = 0; i < 2; i++) {
      const r = await serveDemoEdge(req(`${D}/en`), c, origin, yes, null, cache);
      expect(r.headers.get('x-demo-edge')).toBeNull();
    }
    await c.settle();
    expect(renders).toBe(2);
    expect([...cache.m.keys()]).toEqual([`${D}/en`]);
  });
  it('an entry stored before this ruling (no build in its key) is never read', async () => {
    const cache = fakeCache();
    const legacy = await pageOf('pre-ruling')();
    legacy.headers.set('x-edge-cached-at', String(Date.now()));
    cache.m.set(`${D}/en`, legacy);
    const c = ctx();
    const r = await serveDemoEdge(req(`${D}/en`), c, pageOf('new-build'), yes, BUILD, cache);
    await c.settle();
    expect(r.headers.get('x-demo-edge')).toBe('MISS');
    expect(await r.text()).toContain('new-build.js');
  });
});
