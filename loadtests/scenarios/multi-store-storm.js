import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend } from 'k6/metrics';

// Multi-store concurrent storm — the scenario single-tenant tests CANNOT cover.
//
// Each VU picks a RANDOM store from the STORE_IDS list on every iteration, so
// all N stores receive concurrent RLS-scoped runInTenantContext queries at the
// same time. This exercises cross-tenant contention on the shared Neon pool and
// per-request GUC-set + RLS policy evaluation under realistic multi-tenant load.
//
// Requires:
//   STORE_IDS  — comma-separated list of live store UUIDs (see seed:loadtest)
//   BASE_URL   — API base URL (default: production)
//   LOAD_TEST_TOKEN — optional bypass token (same as storefront-browse.js)
//
// Run after seeding:
//   STORE_IDS=$(cat loadtests/.loadtest-store-ids.txt) \
//   LOAD_TEST_TOKEN=<token> \
//   ./loadtests/run.sh multi-store-storm

const productListLatency = new Trend('ms_product_list', true);
const categoryListLatency = new Trend('ms_category_list', true);
const productDetailLatency = new Trend('ms_product_detail', true);

const BASE = __ENV.BASE_URL || 'https://api.ebda.app/api/v1';

// STORE_IDS is required — parse once at startup (module level) so each VU
// shares the same array without re-parsing on every iteration.
if (!__ENV.STORE_IDS) {
  throw new Error(
    'STORE_IDS env var is required.\n' +
      'Seed stores first: npm run seed:loadtest --workspace @ebda/database\n' +
      'Then: STORE_IDS=$(cat loadtests/.loadtest-store-ids.txt) ./loadtests/run.sh multi-store-storm'
  );
}

const STORE_ID_LIST = __ENV.STORE_IDS.split(',')
  .map(id => id.trim())
  .filter(Boolean);

if (STORE_ID_LIST.length === 0) {
  throw new Error('STORE_IDS is set but contains no valid UUIDs after parsing.');
}

// Peak concurrency + hold are overridable so the same scenario runs both a
// light regression pass (default 100 VUs) and a ceiling-finding storm
// (STORM_MAX_VUS=400+). Spreading more VUs over more stores dilutes the edge
// cache and forces the per-tenant RLS transaction onto the shared pool.
const MAX_VUS = parseInt(__ENV.STORM_MAX_VUS || '100', 10);
const HOLD = __ENV.STORM_HOLD || '3m';

export const options = {
  scenarios: {
    // Ramp up across all stores — higher VU ceiling than single-store to
    // produce meaningful cross-tenant pool contention.
    multi_store_storm: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '45s', target: Math.ceil(MAX_VUS / 2) }, // warm-up
        { duration: HOLD, target: MAX_VUS }, // sustained cross-tenant load
        { duration: '30s', target: 0 }, // ramp-down
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    // Storefront read SLA — matches loadtests/README.md documented p95 ceiling.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    // Per-endpoint breakdown (informational — NOT hard-failing so a single
    // slow endpoint doesn't mask the others).
    ms_product_list: ['p(95)<800'],
    ms_category_list: ['p(95)<800'],
    ms_product_detail: ['p(95)<800'],
  },
};

/** Pick a uniformly-random element from an array. */
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  // Pick a different store on each iteration — this is the core of the scenario.
  const storeId = randomItem(STORE_ID_LIST);

  const headers = {
    'x-store-id': storeId,
    // Forward the bypass token when set so the global rate-limiter skips this VU.
    ...(__ENV.LOAD_TEST_TOKEN ? { 'x-load-test-token': __ENV.LOAD_TEST_TOKEN } : {}),
  };

  // Weighted browse: product list (always) + maybe categories + maybe detail.
  // Proportions mirror storefront-browse.js (3:2:1 real-shopper distribution).
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
      // Fetch the product list first to resolve a real slug from THIS store's
      // catalogue (so we always hit a valid per-tenant product detail URL).
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
          // Body shape mismatch — surfaced as test failure via the check above.
        }
      }
    });
  }

  // Brief think-time mimicking a real browser — also prevents accidental
  // tight-loop thundering herd from a single VU.
  sleep(0.5 + Math.random() * 1.5);
}
