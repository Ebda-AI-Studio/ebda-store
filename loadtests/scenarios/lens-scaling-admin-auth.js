import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend } from 'k6/metrics';

// Lens-scaling admin-auth — authenticated admin order-list cost curve.
//
// Every other scenario in this suite exercises the PUBLIC/guest storefront
// surface (product list, PDP, categories, layout, guest cart→checkout,
// cross-tenant RLS contention). None of them log in and drive an
// authenticated admin session, so the admin / Orders PWA order-list
// endpoint — which `docs/audits/2026-07-12-scaling-cliff-reel.md` finding
// #4 shows has an OFFSET-pagination cost curve (`OrderService.list`,
// `apps/api/src/services/order.service.ts`) — has never had its headroom
// MEASURED, only reasoned about. This scenario closes that gap: log in
// once (via `setup()`, so the shared 15-req/15min `authLimiter` isn't
// tripped by every VU logging in independently), reuse the JWT, and hit
// `GET /stores/:storeId/orders` at a few page depths so the per-depth p95
// is a real measurement instead of a guess.
//
// LOW PRIORITY (finding #6) — small scenario, small VU count. Its purpose
// is measurement of the offset cost curve, not a stress test.
//
// Requires a dedicated load-test admin/staff account for STORE_ID — do not
// point this at a real merchant's own credentials. Read-only (no writes),
// but still recommended against staging rather than production, same
// caution as checkout-flow.js.
//
// Run:
//   STORE_ID=<uuid> ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> \
//   ./loadtests/run.sh lens-scaling-admin-auth

const BASE = __ENV.BASE_URL || 'https://api.ebda.app/api/v1';
const STORE_ID = __ENV.STORE_ID;
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL;
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD;
// Page depths to sample per iteration, at limit=50/page — shallow (page 1,
// what an admin sees on first load), medium, and deep (mimics a merchant
// with a large order history paging far back). Override via PAGE_DEPTHS,
// e.g. "1,10,50,200".
const PAGE_DEPTHS = (__ENV.PAGE_DEPTHS || '1,25,100')
  .split(',')
  .map(p => parseInt(p.trim(), 10))
  .filter(p => Number.isFinite(p) && p > 0);
const PAGE_LIMIT = __ENV.PAGE_LIMIT || '50';

if (!STORE_ID || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error('STORE_ID, ADMIN_EMAIL, and ADMIN_PASSWORD env vars are required.');
}

if (PAGE_DEPTHS.length === 0) {
  throw new Error('PAGE_DEPTHS parsed to an empty list — check the PAGE_DEPTHS env var.');
}

// One Trend per page depth so a slow deep page doesn't mask a fast shallow
// one — same convention as lens-n-medium-traffic.js's per-endpoint metrics.
const depthLatency = {};
for (const depth of PAGE_DEPTHS) {
  depthLatency[depth] = new Trend(`ms_orders_page_${depth}`, true);
}

// Small, low-VU profile — this scenario measures a cost CURVE (how latency
// grows with page depth), not concurrency ceiling. A handful of concurrent
// admin sessions is realistic for the Orders PWA / admin dashboard; heavier
// concurrent-admin load isn't a realistic production shape for this route.
const MAX_VUS = parseInt(__ENV.LENS_ADMIN_MAX_VUS || '5', 10);

export const options = {
  scenarios: {
    lens_scaling_admin_auth: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '20s', target: MAX_VUS },
        { duration: '90s', target: MAX_VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    // Overall ceiling matches the code-quality rule ("fix p95 > 500ms before
    // ship") — this is what the shallow/first-page load must clear, since
    // that's what an admin sees on every dashboard visit.
    http_req_duration: ['p(95)<500'],
    // Shallow page — hard-failing. This is the common case (page 1 of the
    // Orders PWA / admin order list) and must stay fast regardless of how
    // deep OTHER admins have paged.
    [`ms_orders_page_${PAGE_DEPTHS[0]}`]: ['p(95)<500'],
    // Deeper pages are informational only (not hard-failing): under the
    // current OFFSET-only `OrderService.list` (finding #4), latency is
    // EXPECTED to grow with page depth — that growth is exactly what this
    // scenario measures, not a regression to gate on. Once the cursor path
    // (finding #2) is adopted by deep-paging callers, re-baseline this
    // threshold tighter.
  },
};

/** Log in once for the whole test run — never per-VU (would trip authLimiter's
 *  15-req/15min/IP+email cap almost immediately at any real VU count). */
export function setup() {
  const r = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, storeId: STORE_ID }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (r.status !== 200) {
    throw new Error(`Admin login failed (${r.status}): ${r.body}`);
  }
  const token = r.json('data.accessToken');
  if (!token) {
    throw new Error('Admin login response had no data.accessToken.');
  }
  return { token };
}

export default function (data) {
  const headers = {
    Authorization: `Bearer ${data.token}`,
    ...(__ENV.LOAD_TEST_TOKEN ? { 'x-load-test-token': __ENV.LOAD_TEST_TOKEN } : {}),
  };

  for (const depth of PAGE_DEPTHS) {
    group('orders-list', () => {
      const r = http.get(`${BASE}/stores/${STORE_ID}/orders?page=${depth}&limit=${PAGE_LIMIT}`, {
        headers,
      });
      depthLatency[depth].add(r.timings.duration);
      check(r, { [`orders page=${depth} 200`]: res => res.status === 200 });
    });
  }

  // Think-time mimicking an admin paging through a few screens.
  sleep(1 + Math.random() * 2);
}
