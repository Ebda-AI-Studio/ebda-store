import { describe, it, expect } from 'vitest';
import { suspendedStore503, SUSPENDED_STORE_MARKER } from './suspended-store-edge';

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });

describe('suspendedStore503 (QA-116)', () => {
  it('a suspended storefront page becomes 503, noindex, no-store, body kept', async () => {
    const page = `<html><body><div id="main-content" ${SUSPENDED_STORE_MARKER}>المتجر غير متاح مؤقتًا</div></body></html>`;
    const res = await suspendedStore503(html(page));
    expect(res.status).toBe(503);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toBe(page);
  });

  it('a normal page streams through unchanged (status, headers and every byte)', async () => {
    const res = await suspendedStore503(html('<html><body>shop</body></html>'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBeNull();
    expect(await res.text()).toBe('<html><body>shop</body></html>');
  });

  it('a multi-chunk normal page is not truncated or reordered', async () => {
    const enc = new TextEncoder();
    const chunks = ['<html>', '<body>', 'a', 'b', '</body></html>'];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const x of chunks) c.enqueue(enc.encode(x));
        c.close();
      },
    });
    const res = await suspendedStore503(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } })
    );
    expect(await res.text()).toBe(chunks.join(''));
  });

  it('non-HTML, non-200 and empty bodies are never touched', async () => {
    const json = new Response(`{"x":"${SUSPENDED_STORE_MARKER}"}`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    expect((await suspendedStore503(json)).status).toBe(200);
    expect((await suspendedStore503(html('x', { status: 404 }))).status).toBe(404);
    const empty = new Response(null, { status: 200, headers: { 'content-type': 'text/html' } });
    expect((await suspendedStore503(empty)).status).toBe(200);
  });
});
