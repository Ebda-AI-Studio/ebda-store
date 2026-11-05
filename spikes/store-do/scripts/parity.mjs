// Parity of the flagged demo store: Postgres path vs StoreDO path on the same production Worker (Task 0.4).
//   node scripts/parity.mjs --store-id <uuid> [--base https://api.ebda.app]
// RETIRED: the per-request `x-ebda-backend` header is ignored (Ruling CF-BACKEND-1); the backend is the store's D1 flag.
// Order create cannot be compared byte-for-byte: demo stores refuse orders on the Postgres path (Ruling LOOKS-4),
// so the DO order total is checked against the Postgres catalogue price instead, and the Postgres refusal is asserted.
import { randomUUID } from 'node:crypto';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const base = arg('base', 'https://api.ebda.app').replace(/\/$/, '');
const storeId = arg('store-id');
if (!storeId) throw new Error('--store-id required');
const api = `${base}/api/v1/public`;
const H = (doPath, extra = {}) => ({
  'x-store-id': storeId,
  accept: 'application/json',
  'content-type': 'application/json',
  ...extra,
});
// Minimal valid createOrderSchema body (routes/public.routes.ts): the DO path ignores it, the validator does not.
const ORDER_BODY = JSON.stringify({
  shippingAddress: {
    firstName: 'Parity',
    lastName: 'Check',
    address1: '1 Test St',
    country: 'EG',
    phone: '01000000000',
  },
  paymentMethod: 'cod',
});
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

// 1. product list
const pick = p => ({ id: p.id, name: p.name, slug: p.slug, price: p.price, status: p.status });
const [pg, dop] = await Promise.all(
  [false, true].map(async d => {
    const r = await fetch(`${api}/products?limit=24`, { headers: H(d) });
    return { status: r.status, backend: r.headers.get('x-store-backend'), body: await r.json() };
  })
);
check('products: pg path is not served by the DO', pg.backend !== 'do');
check('products: do path says x-store-backend: do', dop.backend === 'do', `got ${dop.backend}`);
const A = new Map(pg.body.data.products.map(p => [p.id, pick(p)]));
const B = new Map(dop.body.data.products.map(p => [p.id, pick(p)]));
const mismatched = [...B].filter(([id, p]) => JSON.stringify(A.get(id)) !== JSON.stringify(p));
check(
  'products: every DO row equals the Postgres row on {id,name,slug,price,status}',
  B.size > 0 && mismatched.length === 0,
  `do=${B.size} pg=${A.size} mismatched=${mismatched.length}`
);
// 2. cart add
const simple = pg.body.data.products.find(p => (p.inventory ?? 0) > 3 && !p.hasVariants);
const add = async (d, sid) => {
  const r = await fetch(`${api}/cart/items`, {
    method: 'POST',
    headers: H(d, { 'x-session-id': sid }),
    body: JSON.stringify({ productId: simple.id, quantity: 2 }),
  });
  return { status: r.status, backend: r.headers.get('x-store-backend'), body: await r.json() };
};
const sidA = `parity-pg-${randomUUID()}`;
const sidB = `parity-do-${randomUUID()}`;
const [ca, cb] = [await add(false, sidA), await add(true, sidB)];
check(
  'cart: both paths accept the same add (HTTP 200)',
  ca.status === 200 && cb.status === 200,
  `pg=${ca.status} do=${cb.status}`
);
check(
  'cart: do path served by the DO and returns a cart id',
  cb.backend === 'do' && !!cb.body.data?.cart?.id
);

// 3. order create
const ordPg = await fetch(`${api}/orders`, {
  method: 'POST',
  headers: H(false, { 'x-session-id': sidA }),
  body: ORDER_BODY,
});
check(
  'order: Postgres path refuses an order on a demo store (LOOKS-4, unchanged)',
  ordPg.status >= 400 && ordPg.status < 500,
  `HTTP ${ordPg.status}`
);
const ordDo = await fetch(`${api}/orders`, {
  method: 'POST',
  headers: H(true, { 'x-session-id': sidB }),
  body: ORDER_BODY,
});
const ob = await ordDo.json();
check(
  'order: DO path creates the order (201) with total = qty x Postgres price',
  ordDo.status === 201 && ob.data?.order?.total === simple.price * 2,
  `HTTP ${ordDo.status} total=${ob.data?.order?.total} want=${simple.price * 2}`
);

const pass = results.filter(Boolean).length;
console.log(`parity: ${pass}/${results.length} checks pass`);
process.exit(pass === results.length ? 0 : 1);
