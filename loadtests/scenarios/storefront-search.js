// Storefront search under load: 70% full search (hybrid path), 30% typeahead (lexical).
// Run against LOCAL dev or a staging/preview Worker only (host allowlist, see lib/allowed-host.js) — never production (a search writes the
// search log, and a hybrid search spends the Workers AI query-embed budget).
//   BASE_URL=http://localhost:4000/api/v1 STORE_ID=<uuid> k6 run loadtests/scenarios/storefront-search.js
//
// Knobs (all optional):
//   RATE=30 DURATION=2m          arrival rate (req/s) and length
//   SEARCH_SHARE=0.7             share of full searches (the rest is typeahead)
//   UNIQUE=true                  default: most terms are made unique, which defeats the 120 s
//                                getCached so the DB path is what gets measured. UNIQUE=false
//                                repeats the 20 terms (warm cache).
//   QUERIES_FILE=/abs/queries.json   JSON array of terms (e.g. the eval set) instead of TERMS
//   LOADTEST_ALLOWED_HOSTS=h1,h2  exact non-local hosts this run may hit (a preview Worker); production
//                                hosts are refused even when listed
//   LOAD_TEST_TOKEN=...          sent as x-load-test-token (lifts the 300/min public limiter when
//                                the host has LOAD_TEST_BYPASS_TOKEN). Not the per-searcher embed
//                                limit, which stays on by design (see loadtests/README.md).
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { assertAllowedHost } from './lib/allowed-host.js';

const TERMS = [
  'احذيه',
  'عبايه سودا',
  '3abaya',
  'كوتشي',
  'شنطه',
  'مكرونه',
  'phone case',
  'سماعه بلوتوث',
  'بيجامه',
  'روج',
  'كشكول',
  'بطانيه',
  'جراب موبايل',
  'ساعه',
  'برفيوم',
  'تيشرت',
  'jeans',
  'رز',
  'بلح',
  'كنافه',
];

const terms = __ENV.QUERIES_FILE ? JSON.parse(open(__ENV.QUERIES_FILE)) : TERMS;
const base = __ENV.BASE_URL;
const store = __ENV.STORE_ID;
if (!base || !store) throw new Error('BASE_URL and STORE_ID are required');
assertAllowedHost(base, __ENV.LOADTEST_ALLOWED_HOSTS);

const searchShare = Number(__ENV.SEARCH_SHARE || 0.7);
const unique = __ENV.UNIQUE !== 'false';
const headers = {
  'x-store-id': store,
  ...(__ENV.LOAD_TEST_TOKEN ? { 'x-load-test-token': __ENV.LOAD_TEST_TOKEN } : {}),
};

// Mode of each full search, read from the response meta (not a failure either way).
const ranked = new Rate('search_ranked');
const degraded = new Rate('search_degraded');

export const options = {
  scenarios: {
    search: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 30),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 40,
      maxVUs: 400,
    },
  },
  thresholds: {
    'http_req_duration{kind:search}': ['p(95)<500'],
    'http_req_duration{kind:suggest}': ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const term =
    terms[Math.floor(Math.random() * terms.length)] +
    (!unique || Math.random() < 0.5 ? '' : ` ${__ITER % 97}`);
  if (Math.random() < searchShare) {
    const r = http.get(`${base}/public/products?search=${encodeURIComponent(term)}`, {
      headers,
      tags: { kind: 'search' },
    });
    const ok = check(r, { 'search 200': x => x.status === 200 });
    if (ok) {
      const meta = r.json('data.meta') || {};
      ranked.add(meta.ranked === true);
      degraded.add(meta.degraded === true);
    }
  } else {
    const r = http.get(
      `${base}/public/${store}/search/suggest?q=${encodeURIComponent(term.slice(0, 4))}`,
      { headers, tags: { kind: 'suggest' } }
    );
    check(r, { 'suggest 200': x => x.status === 200 });
  }
}
