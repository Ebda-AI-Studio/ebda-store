import http from 'k6/http';
import { check } from 'k6';

// API bursts — simulates a flash-sale style spike. Constant arrival
// rate so we measure the API's throughput ceiling, not the VU pool's.
// Targets the same edge-cached read endpoints as storefront-browse
// but with much heavier concurrency and no think-time.

const BASE = __ENV.BASE_URL || 'https://api-production-c058.up.railway.app/api/v1';
const STORE_ID = __ENV.STORE_ID;

if (!STORE_ID) {
  throw new Error('STORE_ID env var required.');
}

export const options = {
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: 200, // 200 requests/second
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
  },
};

const headers = {
  'x-store-id': STORE_ID,
  ...(__ENV.LOAD_TEST_TOKEN ? { 'x-load-test-token': __ENV.LOAD_TEST_TOKEN } : {}),
};

export default function () {
  const r = http.get(`${BASE}/public/products?limit=12`, { headers });
  check(r, { '2xx': res => res.status >= 200 && res.status < 300 });
}
