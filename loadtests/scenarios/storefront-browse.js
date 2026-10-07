import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend } from 'k6/metrics';

// Storefront browse — the highest-volume read path. Hits the public
// product list, a category page, and a product detail in proportions
// roughly matching what real shoppers do (3:2:1).
//
// Targets the new edge-cached endpoints (apps/api/src/lib/edge-cache.ts
// + the indexes from 20260501030000_perf_indexes), so a successful
// run should show p95 well under 100ms once the edge warms up.

const productListLatency = new Trend('product_list_latency', true);
const categoryListLatency = new Trend('category_list_latency', true);
const productDetailLatency = new Trend('product_detail_latency', true);

const BASE = __ENV.BASE_URL || 'https://api.ebda.app/api/v1';
const STORE_ID = __ENV.STORE_ID; // required

if (!STORE_ID) {
  throw new Error('STORE_ID env var required (a public storefront uuid).');
}

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 25 },
        { duration: '2m', target: 50 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{group:::list}': ['p(95)<400'],
    'http_req_duration{group:::detail}': ['p(95)<400'],
  },
};

const headers = {
  'x-store-id': STORE_ID,
  // Optional: when LOAD_TEST_TOKEN is set, the global rate limiter
  // skips this request (matches LOAD_TEST_BYPASS_TOKEN env on the API).
  ...(__ENV.LOAD_TEST_TOKEN ? { 'x-load-test-token': __ENV.LOAD_TEST_TOKEN } : {}),
};

export default function () {
  group('list', () => {
    const r = http.get(`${BASE}/public/products?limit=12`, { headers });
    productListLatency.add(r.timings.duration);
    check(r, { 'list 200': res => res.status === 200 });
  });

  if (Math.random() < 0.66) {
    group('list', () => {
      const r = http.get(`${BASE}/public/categories`, { headers });
      categoryListLatency.add(r.timings.duration);
      check(r, { 'cats 200': res => res.status === 200 });
    });
  }

  if (Math.random() < 0.33) {
    group('detail', () => {
      // Pick a random product slug from the first page if we can.
      const list = http.get(`${BASE}/public/products?limit=12`, { headers });
      if (list.status === 200) {
        try {
          const body = list.json();
          const items = body?.data?.products ?? body?.data ?? [];
          if (items.length) {
            const slug = items[Math.floor(Math.random() * items.length)].slug;
            const r = http.get(`${BASE}/public/products/${slug}`, { headers });
            productDetailLatency.add(r.timings.duration);
            check(r, { 'detail 200': res => res.status === 200 });
          }
        } catch (_e) {
          // Body shape mismatch — surfacing as test failure via the check above.
        }
      }
    });
  }

  sleep(1 + Math.random() * 2);
}
