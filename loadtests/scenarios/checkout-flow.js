import http from 'k6/http';
import { check, sleep, group } from 'k6';

// End-to-end guest checkout: add to cart → confirm cart → place order.
// Lower concurrency than browse (real checkouts are ~1% of sessions)
// but this exercises the inngest/order-created fan-out and the edge
// cache invalidation path.
//
// IMPORTANT: writes real orders. Run only against staging (or a
// disposable dev store) — set STORE_ID to a test store seeded with
// at least one purchasable product.

const BASE = __ENV.BASE_URL || 'https://api-production-c058.up.railway.app/api/v1';
const STORE_ID = __ENV.STORE_ID;
const PRODUCT_SLUG = __ENV.PRODUCT_SLUG;

if (!STORE_ID || !PRODUCT_SLUG) {
  throw new Error('STORE_ID and PRODUCT_SLUG env vars required.');
}

export const options = {
  scenarios: {
    checkout: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 5 },
        { duration: '2m', target: 10 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<2500'],
  },
};

const headers = { 'x-store-id': STORE_ID, 'Content-Type': 'application/json' };

export default function () {
  let cartId;

  group('cart', () => {
    const r = http.post(`${BASE}/public/cart`, JSON.stringify({}), { headers });
    if (check(r, { 'cart 200/201': res => res.status === 200 || res.status === 201 })) {
      cartId = r.json('data.cart.id') || r.json('data.id');
    }
  });

  if (!cartId) return;

  group('cart', () => {
    const detail = http.get(`${BASE}/public/products/${PRODUCT_SLUG}`, { headers });
    const productId = detail.json('data.product.id') || detail.json('data.id');
    if (!productId) return;
    const r = http.post(
      `${BASE}/public/cart/${cartId}/items`,
      JSON.stringify({ productId, quantity: 1 }),
      { headers }
    );
    check(r, { 'add to cart 200': res => res.status === 200 || res.status === 201 });
  });

  sleep(0.5 + Math.random() * 1.5);

  group('place', () => {
    const orderBody = JSON.stringify({
      cartId,
      paymentMethod: 'cod',
      shippingAddress: {
        firstName: 'LoadTest',
        lastName: 'Buyer',
        email: `lt-${__VU}-${__ITER}@example.com`,
        phone: '+96599999999',
        address1: '1 Block Street',
        city: 'Kuwait City',
        state: 'Capital',
        postalCode: '00000',
        country: 'KW',
      },
    });
    const r = http.post(`${BASE}/public/orders`, orderBody, { headers });
    check(r, { 'order 201': res => res.status === 200 || res.status === 201 });
  });

  sleep(2 + Math.random() * 3);
}
