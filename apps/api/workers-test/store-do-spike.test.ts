import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';

// Not ./helpers: it imports @ebda/shared, which this test does not need.
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
};
const api = e.API;

// The built Worker's StoreDO, through the operator loader (lib/store-backend.ts, routes/store-do-spike.routes.ts).
const base = 'https://api.ebda.app/api/v1/internal/store-do';
const auth = {
  authorization: 'Bearer workers-test-seed-token',
  'content-type': 'application/json',
};
const now = Date.now();
const rows = (storeId: string) => ({
  store: { id: storeId, slug: 's', name: 'S', currency: 'EGP', createdAt: now, updatedAt: now },
  products: [
    {
      id: 'p1',
      storeId,
      name: 'P',
      slug: 'p',
      price: 1000,
      inventory: 3,
      status: 'active',
      hasVariants: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
});

// Every API request leases a Postgres connection first (worker.ts withWorkerContext), so this needs the local pooler.
describe.skipIf(e.E2E_DB !== '1')('StoreDO loader (flag + secret gated)', () => {
  it('404 for a store that is not flagged, even with the token', async () => {
    const r = await api.fetch(`${base}/not-flagged/counts`, { headers: auth });
    expect(r.status).toBe(404);
  });
  it('403 for a flagged store without the right token', async () => {
    const r = await api.fetch(`${base}/spike-store-1/counts`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(r.status).toBe(403);
  });
  it('seeds the flagged store and reports row counts from its own SQLite DO', async () => {
    const seed = await api.fetch(`${base}/spike-store-1/seed`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(rows('spike-store-1')),
    });
    expect(seed.status).toBe(200);
    const counts = await api.fetch(`${base}/spike-store-1/counts`, { headers: auth });
    const body = (await counts.json()) as { data: Record<string, number> };
    expect(body.data.products).toBe(1);
    expect(body.data.orders).toBe(0);
  });
});
