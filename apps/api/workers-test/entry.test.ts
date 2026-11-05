import { describe, expect, it } from 'vitest';
import { api, ENV_DB } from './helpers';

const call = (path: string, init: RequestInit = {}) =>
  api.fetch(`https://api.ebda.app${path}`, init);

describe('worker entry (the built bundle, in workerd)', () => {
  it('/health reports the build identity: commit from vars, deploymentId from version metadata', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      commit: string | null;
      deploymentId: string | null;
    };
    expect(body.status).toBe('ok');
    expect(body.commit).toBe('test-sha');
    expect(typeof body.deploymentId === 'string' || body.deploymentId === null).toBe(true);
  });

  it('unknown routes answer the JSON 404, not an HTML page that fingerprints the framework', async () => {
    const res = await call('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('a spoofed X-Forwarded-For is replaced by the address Cloudflare saw', async () => {
    // 6 logins of one email from one real client, each claiming a different X-Forwarded-For: the
    // limiter keys on cf-connecting-ip, so they all count against ONE bucket. (The lockout counter
    // trips at 5, so the 6th answer is a lockout or invalid credentials, never a fresh budget.)
    const email = `spoof-${crypto.randomUUID()}@exit-test.invalid`;
    const remaining: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '10.9.9.9',
          'x-forwarded-for': `203.0.113.${i + 1}`,
        },
        body: JSON.stringify({ email, password: 'wrong-password-1' }),
      });
      remaining.push(res.headers.get('ratelimit-remaining') ?? '');
      await res.arrayBuffer();
    }
    expect(remaining).toEqual(['14', '13', '12']);
  });

  it('the auth limiter (15 / 15 min per IP + email) is shared state: the 16th attempt is a 429', async () => {
    const email = `limit-${crypto.randomUUID()}@exit-test.invalid`;
    const statuses: number[] = [];
    const codes: Array<string | undefined> = [];
    for (let i = 0; i < 17; i++) {
      const res = await call('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.8.8.8' },
        body: JSON.stringify({ email, password: 'wrong-password-1' }),
      });
      statuses.push(res.status);
      codes.push(
        ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code
      );
    }
    expect(codes.slice(0, 15)).not.toContain('RATE_LIMITED');
    expect(statuses[15]).toBe(429);
    expect(codes[15]).toBe('RATE_LIMITED');
    expect(codes[16]).toBe('RATE_LIMITED');
  });

  it('a different client is not limited by the first one', async () => {
    const res = await call('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.7.7.7' },
      body: JSON.stringify({ email: 'someone@exit-test.invalid', password: 'wrong-password-1' }),
    });
    expect(res.status).not.toBe(429);
    await res.arrayBuffer();
  });
});

describe.skipIf(!ENV_DB())(
  'with the local database (pgbouncer in transaction mode, ebda_app)',
  () => {
    const read = (host: string, query = '') =>
      call(`/api/v1/public/products?limit=20${query}`, {
        headers: {
          'x-store-domain': host,
          'cf-connecting-ip': `10.5.${Math.floor(Math.random() * 250)}.1`,
        },
      });

    it('a tenant read is routed by host and only returns that tenant', async () => {
      for (const [host, tag] of [
        ['alpha.ebda.app', 'ALPHA'],
        ['bravo.ebda.app', 'BRAVO'],
      ] as const) {
        const res = await read(host, `&k=${crypto.randomUUID()}`);
        expect(res.status).toBe(200);
        const products = ((await res.json()) as { data: { products: Array<{ name: string }> } })
          .data.products;
        expect(products.length).toBeGreaterThan(0);
        expect(products.every(p => p.name.startsWith(tag))).toBe(true);
      }
    });

    it('an unknown host is refused, never the first store', async () => {
      const res = await read('nobody-here.ebda.app');
      expect(res.status).toBe(400);
    });

    it('a write is committed before the response: a separate request sees it', async () => {
      const productsRes = await read('alpha.ebda.app', `&k=${crypto.randomUUID()}`);
      const first = ((await productsRes.json()) as { data: { products: Array<{ id: string }> } })
        .data.products[0];
      const sessionId = `workers-test-${crypto.randomUUID()}`;
      const headers = {
        'content-type': 'application/json',
        'x-store-domain': 'alpha.ebda.app',
        'x-session-id': sessionId,
        'cf-connecting-ip': '10.6.6.6',
      };
      const add = await call('/api/v1/public/cart/items', {
        method: 'POST',
        headers,
        body: JSON.stringify({ productId: first.id, quantity: 2 }),
      });
      expect(add.status).toBe(200);
      // The response is out; the very next request (its own client, its own connection) must read the row.
      const cart = await call('/api/v1/public/cart', { headers });
      expect(cart.status).toBe(200);
      const items = (
        (await cart.json()) as {
          data: { cart: { items: Array<{ productId: string; quantity: number }> } };
        }
      ).data.cart.items;
      expect(items.map(i => [i.productId, i.quantity])).toEqual([[first.id, 2]]);
    });

    it("a hostile write (this host, the other store's product) is refused", async () => {
      const other = await read('bravo.ebda.app', `&k=${crypto.randomUUID()}`);
      const bravo = ((await other.json()) as { data: { products: Array<{ id: string }> } }).data
        .products[0];
      const res = await call('/api/v1/public/cart/items', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-store-domain': 'alpha.ebda.app',
          'x-session-id': `workers-test-${crypto.randomUUID()}`,
          'cf-connecting-ip': '10.6.6.7',
        },
        body: JSON.stringify({ productId: bravo.id, quantity: 1 }),
      });
      expect(res.status).toBe(404);
    });

    it('50 parallel mixed requests across both stores: 0 errors, 0 leaks', async () => {
      const jobs = Array.from({ length: 50 }, (_, i) => {
        const host = i % 2 === 0 ? 'alpha.ebda.app' : 'bravo.ebda.app';
        return read(host, `&k=${crypto.randomUUID()}`).then(async res => ({
          host,
          status: res.status,
          products: ((await res.json()) as { data: { products: Array<{ name: string }> } }).data
            .products,
        }));
      });
      const results = await Promise.all(jobs);
      for (const r of results) {
        expect(r.status).toBe(200);
        const tag = r.host.startsWith('alpha') ? 'ALPHA' : 'BRAVO';
        expect(r.products.every(p => p.name.startsWith(tag))).toBe(true);
      }
    });
  }
);
