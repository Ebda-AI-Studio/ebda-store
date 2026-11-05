// Reusable k6 script driven by the `load-test` workflow (.github/workflows/load-test.yml). Ruling SCALE-READY-1 #7.
// Env: BASE_URL (api root incl. /api/v1), SCENARIO (smoke|storefront-mix|flash-sale), DURATION, RPS,
//      PATHS (comma list, smoke), STORE_IDS (comma list, store scenarios), PRODUCT_SLUG (flash-sale),
//      P95_MS (default 500), ERROR_RATE (default 0).
// SAFETY: flash-sale stops after add-to-cart. It NEVER places an order or touches payment.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

const BASE = (__ENV.BASE_URL || '').replace(/\/$/, '');
const SCENARIO = __ENV.SCENARIO || 'smoke';
const DURATION = __ENV.DURATION || '60s';
const RPS = Number(__ENV.RPS || 200);
const STORES = (__ENV.STORE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const PATHS = (__ENV.PATHS || '/public/health')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const SLUG = __ENV.PRODUCT_SLUG || '';

if (!BASE) throw new Error('BASE_URL required');
if (SCENARIO !== 'smoke' && STORES.length === 0)
  throw new Error('STORE_IDS required for ' + SCENARIO);
if (SCENARIO === 'flash-sale' && (STORES.length !== 1 || !SLUG))
  throw new Error('flash-sale needs exactly one STORE_IDS entry and PRODUCT_SLUG');

const rate =
  SCENARIO === 'flash-sale' ? RPS : SCENARIO === 'smoke' ? RPS : Math.max(10, Math.floor(RPS / 2));
export const options = {
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.min(500, Math.max(20, rate)),
      maxVUs: 1000,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<' + Number(__ENV.P95_MS || 500)],
    http_req_failed: ['rate<=' + Number(__ENV.ERROR_RATE || 0)],
  },
};

const pick = a => a[Math.floor(Math.random() * a.length)];
const hdr = id => ({ headers: { 'x-store-id': id, 'Content-Type': 'application/json' } });
const ok = r => r.status >= 200 && r.status < 300;

export default function () {
  if (SCENARIO === 'smoke') {
    check(http.get(BASE + pick(PATHS)), { '2xx': ok });
    return;
  }
  const p = hdr(pick(STORES));
  if (SCENARIO === 'storefront-mix') {
    check(http.get(BASE + '/public/products?limit=24', p), { products: ok });
    check(http.get(BASE + '/public/categories', p), { categories: ok });
    const c = http.post(BASE + '/public/cart', '{}', p);
    if (check(c, { cart: ok })) {
      const id = c.json('data.cart.id') || c.json('data.id');
      const d = SLUG ? http.get(BASE + '/public/products/' + SLUG, p) : null;
      const pid = d && (d.json('data.product.id') || d.json('data.id'));
      if (id && pid)
        check(
          http.post(
            BASE + '/public/cart/' + id + '/items',
            JSON.stringify({ productId: pid, quantity: 1 }),
            p
          ),
          { add: ok }
        );
    }
    sleep(Math.random());
    return;
  }
  // flash-sale: cart -> add item -> read cart. STOPS HERE: no order is placed, no payment is attempted.
  const c = http.post(BASE + '/public/cart', '{}', p);
  if (!check(c, { cart: ok })) return;
  const id = c.json('data.cart.id') || c.json('data.id');
  const d = http.get(BASE + '/public/products/' + SLUG, p);
  const pid = d.json('data.product.id') || d.json('data.id');
  if (!id || !pid) return;
  check(
    http.post(
      BASE + '/public/cart/' + id + '/items',
      JSON.stringify({ productId: pid, quantity: 1 }),
      p
    ),
    { add: ok }
  );
  check(http.get(BASE + '/public/cart/' + id, p), { read: ok });
}

export function handleSummary(data) {
  return { 'k6-summary.json': JSON.stringify(data), stdout: textSummary(data, { indent: ' ' }) };
}
