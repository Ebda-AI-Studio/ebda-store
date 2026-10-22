// Ruling DEMO-EDGE-1: the demo edge cache serves demo hosts only, never a cookie-bearing,
// RSC, draft or non-HTML request, and never changes anything for a real merchant store.
import { describe, it, expect } from 'vitest';
import {
  demoEdgeKey,
  serveDemoEdge,
  DEMO_EDGE_CACHE_CONTROL,
} from '../../apps/web/demo-edge-cache';

const req = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(url, { method, headers: { accept: 'text/html', ...headers } });

describe('demoEdgeKey', () => {
  it('keys a demo host page and sorts the query so ?look= is part of the key', () => {
    const a = demoEdgeKey(req('https://storedemo.ebda.app/categories?look=qamar.lookbook&x=1'));
    const b = demoEdgeKey(req('https://storedemo.ebda.app/categories?x=1&look=qamar.lookbook'));
    const c = demoEdgeKey(req('https://storedemo.ebda.app/categories?look=qamar.vitrine&x=1'));
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it('covers the three demo hosts and no other host', () => {
    for (const h of ['storedemo', 'storedemo-souq', 'storedemo-jasmine'])
      expect(demoEdgeKey(req(`https://${h}.ebda.app/`))).toBeTruthy();
    for (const h of [
      'demo-merchant.ebda.app',
      'shop.example.com',
      'ebda.app',
      'storedemo2.ebda.app',
    ])
      expect(demoEdgeKey(req(`https://${h}/`))).toBeNull();
  });
  it('bypasses non-GET, RSC, actions, non-HTML, api, checkout, preview/draft params', () => {
    const u = 'https://storedemo.ebda.app';
    expect(demoEdgeKey(req(`${u}/`, {}, 'POST'))).toBeNull();
    expect(demoEdgeKey(req(`${u}/`, { rsc: '1' }))).toBeNull();
    expect(demoEdgeKey(req(`${u}/`, { 'next-action': 'x' }))).toBeNull();
    expect(demoEdgeKey(req(`${u}/`, { accept: 'application/json' }))).toBeNull();
    expect(demoEdgeKey(req(`${u}/api/x`))).toBeNull();
    expect(demoEdgeKey(req(`${u}/checkout`))).toBeNull();
    expect(demoEdgeKey(req(`${u}/?_preview=1`))).toBeNull();
    expect(demoEdgeKey(req(`${u}/?_layoutDraft=t`))).toBeNull();
  });
  it('bypasses a request with an auth-looking or draft cookie, ignores analytics cookies', () => {
    const u = 'https://storedemo.ebda.app/';
    expect(demoEdgeKey(req(u, { cookie: 'token=abc' }))).toBeNull();
    expect(demoEdgeKey(req(u, { cookie: 'refresh_token=abc' }))).toBeNull();
    expect(demoEdgeKey(req(u, { cookie: 'force-preview-draft=x' }))).toBeNull();
    expect(demoEdgeKey(req(u, { cookie: '_ga=1; ph_x=2' }))).toBeTruthy();
  });
  it('keys the language and consent cookies (they change the HTML)', () => {
    const u = 'https://storedemo.ebda.app/';
    const ar = demoEdgeKey(req(u, { cookie: 'force-language=ar' }));
    const en = demoEdgeKey(req(u, { cookie: 'force-language=en' }));
    expect(ar).not.toBe(en);
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

describe('serveDemoEdge', () => {
  it('MISS then HIT on a demo host, with the public edge Cache-Control', async () => {
    const cache = fakeCache();
    let renders = 0;
    const origin = async () => (renders++, html());
    const c1 = ctx();
    const r1 = await serveDemoEdge(
      req('https://storedemo.ebda.app/?look=qamar.lookbook'),
      c1,
      origin,
      cache
    );
    await c1.settle();
    expect(r1.headers.get('x-demo-edge')).toBe('MISS');
    expect(r1.headers.get('cache-control')).toBe(DEMO_EDGE_CACHE_CONTROL);
    const r2 = await serveDemoEdge(
      req('https://storedemo.ebda.app/?look=qamar.lookbook'),
      ctx(),
      origin,
      cache
    );
    expect(r2.headers.get('x-demo-edge')).toBe('HIT');
    expect(renders).toBe(1);
  });
  it('a real merchant store is untouched: origin response returned verbatim, nothing stored', async () => {
    const cache = fakeCache();
    const r = await serveDemoEdge(
      req('https://real-shop.ebda.app/'),
      ctx(),
      async () => html(),
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
      req('https://storedemo.ebda.app/a'),
      c,
      async () => new Response('x', { status: 404, headers: { 'content-type': 'text/html' } }),
      cache
    );
    await serveDemoEdge(
      req('https://storedemo.ebda.app/b'),
      c,
      async () =>
        new Response('x', { headers: { 'content-type': 'text/html', 'set-cookie': 'a=b' } }),
      cache
    );
    await c.settle();
    expect(cache.m.size).toBe(0);
  });
});
