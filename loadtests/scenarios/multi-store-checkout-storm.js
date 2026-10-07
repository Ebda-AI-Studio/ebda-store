import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend } from 'k6/metrics';

// Multi-store CHECKOUT storm — the WRITE-path counterpart to multi-store-storm.
//
// Each VU iteration picks a RANDOM store and runs a full guest checkout:
//   pick a product → add to cart → place a COD order.
// Cart + order are keyed by a per-iteration `x-session-id` (distinct guest),
// so each iteration creates a real Order. Order placement is NOT edge-cached:
// it opens the per-tenant runInTenantContext RLS transaction and writes
// Order + OrderItems (+ inngest order-created fan-out). This is where
// cross-tenant pool contention actually bites — no cache to shield it. COD =
// no external gateway. Writes real orders → staging + disposable stores only.
//
// Real API contract (apps/api/src/routes/public.routes.ts):
//   POST /public/cart/items   {productId, quantity}   header x-session-id + x-store-id
//   POST /public/orders       {shippingAddress, paymentMethod}  (cart resolved by session)
//
// Requires: STORE_IDS, BASE_URL, LOAD_TEST_TOKEN.
// Optional: STORM_MAX_VUS (default 50), STORM_HOLD (default 2m).

const orderLatency = new Trend('ms_place_order', true);
const addToCartLatency = new Trend('ms_add_to_cart', true);

const BASE = __ENV.BASE_URL || 'https://api.ebda.app/api/v1';

if (!__ENV.STORE_IDS) {
  throw new Error('STORE_IDS env var is required (comma-separated seeded store UUIDs).');
}
const STORE_ID_LIST = __ENV.STORE_IDS.split(',')
  .map(id => id.trim())
  .filter(Boolean);
if (STORE_ID_LIST.length === 0) {
  throw new Error('STORE_IDS is set but contains no valid UUIDs after parsing.');
}

const MAX_VUS = parseInt(__ENV.STORM_MAX_VUS || '50', 10);
const HOLD = __ENV.STORM_HOLD || '2m';

export const options = {
  scenarios: {
    multi_store_checkout: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '45s', target: Math.ceil(MAX_VUS / 2) },
        { duration: HOLD, target: MAX_VUS },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<2500'],
    ms_place_order: ['p(95)<3000'],
  },
};

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  const storeId = randomItem(STORE_ID_LIST);
  // Distinct guest session per iteration → distinct cart → distinct order.
  const sessionId = `lt-${storeId.slice(0, 8)}-${__VU}-${__ITER}`;
  const headers = {
    'x-store-id': storeId,
    'x-session-id': sessionId,
    'Content-Type': 'application/json',
    ...(__ENV.LOAD_TEST_TOKEN ? { 'x-load-test-token': __ENV.LOAD_TEST_TOKEN } : {}),
  };

  // Resolve a real product from THIS store's catalogue.
  let productId;
  const list = http.get(`${BASE}/public/products?limit=12`, { headers });
  if (list.status === 200) {
    try {
      const body = list.json();
      const items = body?.data?.products ?? body?.data ?? [];
      if (items.length) productId = randomItem(items).id;
    } catch (_e) {
      /* surfaced via the add check below */
    }
  }
  if (!productId) {
    check(list, { 'product list 200': r => r.status === 200 });
    return;
  }

  group('add', () => {
    const r = http.post(`${BASE}/public/cart/items`, JSON.stringify({ productId, quantity: 1 }), {
      headers,
    });
    addToCartLatency.add(r.timings.duration);
    check(r, { 'add to cart 200': res => res.status === 200 || res.status === 201 });
  });

  sleep(0.5 + Math.random() * 1.5); // think-time before placing the order

  group('place', () => {
    const orderBody = JSON.stringify({
      paymentMethod: 'cod',
      shippingAddress: {
        firstName: 'LoadTest',
        lastName: 'Buyer',
        email: `lt-${__VU}-${__ITER}@example.com`,
        phone: '+201000000000',
        address1: '1 Block Street',
        city: 'Cairo',
        state: 'Capital',
        postalCode: '00000',
        country: 'KW',
      },
    });
    const r = http.post(`${BASE}/public/orders`, orderBody, { headers });
    orderLatency.add(r.timings.duration);
    check(r, { 'order 201': res => res.status === 200 || res.status === 201 });
  });

  sleep(1 + Math.random() * 2);
}
