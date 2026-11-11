import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// Smart Placement A/B for ebda-api (PERF-PLACEMENT-1, docs/rulings/PERF-PLACEMENT-1.md).
// Run the SAME file twice, once per arm, against the SAME store, then compare the printed p50/p95:
//   ARM=off BASE_URL=https://<api-host>/api/v1 STORE_ID=<uuid> k6 run loadtests/scenarios/placement-ab.js
//   ARM=on  BASE_URL=https://<placement-copy-host>/api/v1 STORE_ID=<uuid> k6 run loadtests/scenarios/placement-ab.js
// Paths: `hit` = a cacheable public read (KV / edge cache, 0 D1) and `miss` = the same read with a unique
// query string so the edge cache cannot answer (D1 / DO path). READ-ONLY: no write path is exercised (a write arm needs a seeded preview store; not built). The `cf-placement` response header
// (only present when Smart Placement is on) and the colo in `cf-ray` are tallied per arm.
// Behind an ISP that blocks Cloudflare IPs: k6 `hosts` override via HOSTS="api.example:1.2.3.4".

const BASE = __ENV.BASE_URL || 'https://api.ebda.app/api/v1';
const STORE_ID = __ENV.STORE_ID;
const ARM = __ENV.ARM || 'unknown';
const RATE = Number(__ENV.RATE || 3);
const DURATION = __ENV.DURATION || '90s';
if (!STORE_ID) throw new Error('STORE_ID env var required (a public storefront uuid).');

const hosts = {};
for (const pair of (__ENV.HOSTS || '').split(',').filter(Boolean)) {
  const [h, ip] = pair.split(':');
  hosts[h] = ip;
}

export const options = {
  hosts,
  scenarios: {
    ab: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 40,
    },
  },
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'max'],
  thresholds: { http_req_failed: ['rate<0.02'] },
};

const hit = new Trend('ab_hit_ms', true);
const miss = new Trend('ab_miss_ms', true);
const placed = new Counter('ab_placed_responses');

export default function () {
  const headers = { 'x-store-id': STORE_ID };
  const n = __ITER % 3;
  if (n === 0) {
    const r = http.get(`${BASE}/public/products?limit=12`, {
      headers,
      tags: { path: 'hit', arm: ARM },
    });
    hit.add(r.timings.duration);
    if (r.headers['Cf-Placement']) placed.add(1);
    check(r, { 'hit 200': x => x.status === 200 });
  } else if (n === 1) {
    const r = http.get(`${BASE}/public/products?limit=12&ab=${Date.now()}-${__VU}-${__ITER}`, {
      headers,
      tags: { path: 'miss', arm: ARM },
    });
    miss.add(r.timings.duration);
    check(r, { 'miss 200': x => x.status === 200 });
  }
  sleep(0);
}
