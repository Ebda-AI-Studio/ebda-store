/**
 * Ruling CSP-WEB-1: a page served from the worker's edge cache must NOT reuse the nonce it was rendered with.
 * Two responses from the cache carry different nonces, each agreeing between the CSP header, the nonce attributes
 * and the flight payload, and neither is the nonce of the stored copy.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildStorefrontCsp } from '../../apps/web/src/lib/csp';
import { nonceOfCsp, renewNonce } from '../../apps/web/csp-nonce-renew';
import { resetDemoVerdicts, serveDemoEdge } from '../../apps/web/demo-edge-cache';
import {
  parseAllowlist,
  resetStoreVerdicts,
  serveStoreEdge,
  type CacheLike,
  type R2Like,
} from '../../apps/web/store-edge-cache';

const RENDER_NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
const page = (n: string) =>
  `<html><head><script nonce="${n}">dark()</script></head><body>` +
  `<script nonce="${n}">self.__next_f.push([1,"{\\"nonce\\":\\"${n}\\"}"])</script></body></html>`;
const rendered = () =>
  new Response(page(RENDER_NONCE), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': buildStorefrontCsp(RENDER_NONCE),
    },
  });
const agree = async (res: Response) => {
  const nonce = nonceOfCsp(res.headers.get('content-security-policy'))!;
  const body = await res.text();
  expect(nonce).toBeTruthy();
  expect(body).toBe(page(nonce));
  return nonce;
};
const ctx = () => {
  const p: Promise<unknown>[] = [];
  return { waitUntil: (x: Promise<unknown>) => void p.push(x), settle: () => Promise.all(p) };
};

describe('renewNonce', () => {
  it('replaces the nonce in the header and everywhere in the body, and nothing else', async () => {
    const out = renewNonce(rendered());
    const nonce = await agree(out);
    expect(nonce).not.toBe(RENDER_NONCE);
    expect(out.headers.get('content-security-policy')).toBe(buildStorefrontCsp(nonce));
  });
  it('handles a nonce split across stream chunks', async () => {
    const body = page(RENDER_NONCE);
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < body.length; i += 7) c.enqueue(enc.encode(body.slice(i, i + 7)));
        c.close();
      },
    });
    const res = new Response(stream, {
      headers: { 'content-security-policy': buildStorefrontCsp(RENDER_NONCE) },
    });
    await agree(renewNonce(res));
  });
  it('leaves a response without a nonce policy alone', () => {
    const res = new Response('x');
    expect(renewNonce(res)).toBe(res);
  });
});

describe('demo edge cache', () => {
  beforeEach(() => resetDemoVerdicts());
  it('two cache hits carry different nonces, neither the stored one', async () => {
    const m = new Map<string, Response>();
    const cache = {
      match: async (k: RequestInfo | URL) => m.get(String(k))?.clone(),
      put: async (k: RequestInfo | URL, r: Response) => void m.set(String(k), r),
    };
    const url = 'https://storedemo.ebda.app/';
    const req = () => new Request(url, { headers: { accept: 'text/html' } });
    const c = ctx();
    const miss = await serveDemoEdge(
      req(),
      c,
      async () => rendered(),
      async () => true,
      cache
    );
    await c.settle();
    expect(miss.headers.get('x-demo-edge')).toBe('MISS');
    const a = await serveDemoEdge(
      req(),
      ctx(),
      async () => rendered(),
      async () => true,
      cache
    );
    const b = await serveDemoEdge(
      req(),
      ctx(),
      async () => rendered(),
      async () => true,
      cache
    );
    expect(a.headers.get('x-demo-edge')).toBe('HIT');
    expect(b.headers.get('x-demo-edge')).toBe('HIT');
    const na = await agree(a);
    const nb = await agree(b);
    expect(na).not.toBe(nb);
    expect([na, nb]).not.toContain(RENDER_NONCE);
  });
});

describe('store edge cache', () => {
  beforeEach(() => resetStoreVerdicts());
  it('two cache hits carry different nonces, neither the stored one', async () => {
    const m = new Map<string, Response>();
    const cache: CacheLike = {
      match: async k => m.get(k)?.clone(),
      put: async (k, r) => void m.set(k, r),
    };
    const store = new Map<string, string>();
    const r2: R2Like = {
      get: async k => (store.has(k) ? { text: async () => store.get(k)! } : null),
      put: async (k, v) => void store.set(k, v),
    };
    const deps = {
      allow: parseAllowlist('shop-a.ebda.app'),
      r2,
      cache,
      verdict: async () => ({ ok: true, id: 'id-a' }),
      now: () => 1_000_000,
    };
    const req = () => new Request('https://shop-a.ebda.app/', { headers: { accept: 'text/html' } });
    const c = ctx();
    await serveStoreEdge(req(), c, async () => rendered(), deps);
    await c.settle();
    const a = await serveStoreEdge(req(), ctx(), async () => rendered(), deps);
    const b = await serveStoreEdge(req(), ctx(), async () => rendered(), deps);
    expect(a.headers.get('x-store-edge')).toBe('HIT');
    expect(b.headers.get('x-store-edge')).toBe('HIT');
    const na = await agree(a);
    const nb = await agree(b);
    expect(na).not.toBe(nb);
    expect([na, nb]).not.toContain(RENDER_NONCE);
  });
});

describe('Ruling STORE-EDGE-3: the preload Link header gets the fresh nonce too', () => {
  it('a renewed copy carries no trace of the render nonce in CSP, body or Link', async () => {
    const res = new Response(page(RENDER_NONCE), {
      headers: {
        'content-type': 'text/html',
        'content-security-policy': buildStorefrontCsp(RENDER_NONCE),
        link: `</_next/static/media/a.woff2>; rel=preload; as="font"; nonce="${RENDER_NONCE}", </x.css>; rel=preload; as="style"; nonce="${RENDER_NONCE}"`,
      },
    });
    const out = renewNonce(res);
    const fresh = nonceOfCsp(out.headers.get('content-security-policy'))!;
    expect(fresh).not.toBe(RENDER_NONCE);
    expect(out.headers.get('link')).not.toContain(RENDER_NONCE);
    expect(out.headers.get('link')!.split(`nonce="${fresh}"`).length - 1).toBe(2);
    expect(await out.text()).toBe(page(fresh));
  });
});
