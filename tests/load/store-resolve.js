// Store-resolution load test (Ruling RESOLVE-BULLETPROOF-1). LOCAL ONLY: drives page loads across the 5 demo hosts
// plus unknown hosts against a local storefront build whose API is tests/load/resolve-mock-api.mjs (30/min global
// resolve bucket + random 503s). `next start` has no Worker edge, so the store-unavailable render is still a 500 here;
// in the Worker, resolve-unavailable-edge.ts turns exactly that body (digest STORE_TEMPORARILY_UNAVAILABLE) into 503 +
// Retry-After. Those are counted as status_500_store_unavailable (reported, the would-be 503s); any OTHER 5xx fails.
//   PORT=4100 CHAOS_PCT=10 node tests/load/resolve-mock-api.mjs &
//   NEXT_PUBLIC_API_URL=http://127.0.0.1:4100/api/v1 npm run build -w apps/web && PORT=3100 npm run start -w apps/web &
//   WEB=http://127.0.0.1:3100 RATE=300 DURATION=120s k6 run tests/load/store-resolve.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const WEB = (__ENV.WEB || 'http://127.0.0.1:3100').replace(/\/$/, '');
if (/ebda\.app/.test(WEB)) throw new Error('local build only: never point this at production');
const DEMO = [
  'storedemo',
  'storedemo-souq',
  'storedemo-jasmine',
  'storedemo-lamma',
  'storedemo-dahab',
];
const s500 = new Counter('status_500');
const s500Unavailable = new Counter('status_500_store_unavailable');
const s503 = new Counter('status_503');
const s503NoRetry = new Counter('status_503_without_retry_after');
const otherBad = new Counter('status_other_5xx');

export const options = {
  scenarios: {
    pages: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 300),
      timeUnit: '1m',
      duration: __ENV.DURATION || '120s',
      preAllocatedVUs: 20,
    },
  },
  thresholds: {
    status_500: ['count==0'],
    status_other_5xx: ['count==0'],
    status_503_without_retry_after: ['count==0'],
    // demo hosts must keep rendering through the limiter + chaos (stale-if-error); allow the cold first second only
    'checks{kind:demo}': ['rate>0.99'],
  },
};

export default function () {
  const unknown = Math.random() < 0.3;
  const host = unknown
    ? `nobody-${Math.floor(Math.random() * 50)}.example.com`
    : `${DEMO[Math.floor(Math.random() * DEMO.length)]}.ebda.app`;
  const res = http.get(`${WEB}/`, {
    headers: { Host: host, 'X-Forwarded-Host': host },
    redirects: 0,
  });
  if (res.status === 500) {
    if (String(res.body).includes('STORE_TEMPORARILY_UNAVAILABLE')) s500Unavailable.add(1);
    else s500.add(1);
  } else if (res.status === 503) {
    s503.add(1);
    if (!res.headers['Retry-After']) s503NoRetry.add(1);
  } else if (res.status >= 500) otherBad.add(1);
  if (unknown)
    check(
      res,
      {
        'unknown host is 404 or retryable': r =>
          r.status === 404 ||
          r.status === 503 ||
          (r.status === 500 && String(r.body).includes('STORE_TEMPORARILY_UNAVAILABLE')),
      },
      { kind: 'unknown' }
    );
  else
    check(
      res,
      { 'demo host renders': r => r.status === 200 || (r.status >= 300 && r.status < 400) },
      { kind: 'demo' }
    );
}
