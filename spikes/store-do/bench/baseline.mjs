// Baseline: today's Postgres-backed API latency for the 3 spike endpoints (Task 0.1).
// Usage: node baseline.mjs --base https://api.ebda.app --store-id <uuid> [--n 200] [--c 4] [--cold]
//   --cold: only the first request after the caller has been idle (run it after 10 min of silence).
// Order-create: demo stores refuse orders server-side (Ruling LOOKS-4) and production money paths
// must not be exercised by a spike, so this script does NOT call POST /public/orders. The order
// path is baselined in baseline-order-local.* (see README) and reported as NOT measured live.
import { bench, arg } from './lib.mjs';
import { randomUUID } from 'node:crypto';

const base = arg('base', 'https://api.ebda.app').replace(/\/$/, '');
const storeId = arg('store-id');
const n = Number(arg('n', 200));
const c = Number(arg('c', 4));
const cold = process.argv.includes('--cold');
const viaDo = process.argv.includes('--do'); // RETIRED: the x-ebda-backend header is ignored (Ruling CF-BACKEND-1); a store's backend is its D1 flag
const withOrders = viaDo; // order create is exercised ONLY on the DO copy of the demo store
if (!storeId) throw new Error('--store-id required');
const H = {
  'x-store-id': storeId,
  accept: 'application/json',
};
const api = `${base}/api/v1/public`;

async function firstProduct() {
  const r = await fetch(`${api}/products?limit=24`, { headers: H });
  const j = await r.json();
  const p = (j.data?.products ?? []).find(
    x => x.status === 'active' && (x.inventory ?? 0) > 5 && !x.hasVariants
  );
  if (!p) throw new Error('no simple in-stock product on demo store');
  return p.id;
}

const productId = await firstProduct();
const endpoints = {
  'GET products?limit=24': i =>
    fetch(`${api}/products?limit=24`, { headers: H }).then(
      async r => (await r.arrayBuffer(), r.status)
    ),
  'POST cart/items': i =>
    fetch(`${api}/cart/items`, {
      method: 'POST',
      headers: {
        ...H,
        'content-type': 'application/json',
        'x-session-id': `bench-${randomUUID()}`,
      },
      body: JSON.stringify({ productId, quantity: 1 }),
    }).then(async r => (await r.arrayBuffer(), r.status)),
};

if (withOrders) {
  endpoints['POST orders (COD, DO copy)'] = async i => {
    const sid = `bench-ord-${randomUUID()}`;
    const h = { ...H, 'content-type': 'application/json', 'x-session-id': sid };
    const a = await fetch(`${api}/cart/items`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    await a.arrayBuffer();
    if (a.status !== 200) return a.status;
    const t0 = performance.now();
    const r = await fetch(`${api}/orders`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        shippingAddress: {
          firstName: 'Bench',
          lastName: 'Run',
          address1: '1 Test St',
          country: 'EG',
          phone: '01000000000',
        },
        paymentMethod: 'cod',
      }),
    });
    await r.arrayBuffer();
    return { status: r.status === 201 ? 200 : r.status, ms: performance.now() - t0 };
  };
}
const only = arg('only', '');
for (const k of Object.keys(endpoints)) if (only && !k.includes(only)) delete endpoints[k];
const out = {
  measured_at: new Date().toISOString(),
  base,
  storeId,
  mode: cold ? 'cold' : 'warm',
  backend: viaDo ? 'do' : 'pg',
  n,
  concurrency: c,
  endpoints: {},
};
for (const [name, fn] of Object.entries(endpoints)) {
  out.endpoints[name] = cold
    ? await bench(fn, { total: 1, concurrency: 1, warmup: 0 })
    : await bench(fn, { total: n, concurrency: c, warmup: 10 });
}
console.log(JSON.stringify(out, null, 2));
