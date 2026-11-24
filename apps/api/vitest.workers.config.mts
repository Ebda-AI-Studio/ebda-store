import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { existsSync, readdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import webpush from 'web-push';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const BUNDLE = here('./dist-cf/worker.js');
if (!existsSync(BUNDLE)) {
  throw new Error(
    'dist-cf/worker.js is missing: run `npm run -w apps/api cf:dry-run` first (cf:test does)'
  );
}

// Throwaway keys generated per run (never real secrets): with them set, the config-gated branches (web push, OneSignal) EXECUTE in the
// route sweep instead of answering "not configured" before any store read (GET /admin/stores/:id/push/status hid a bare Prisma call
// behind `isConfigured()` and 500ed in production, 2026-11-24).
const sweepVapid = webpush.generateVAPIDKeys();

const apiVars = {
  VAPID_PUBLIC_KEY: sweepVapid.publicKey,
  VAPID_PRIVATE_KEY: sweepVapid.privateKey,
  VAPID_SUBJECT: 'mailto:sweep@example.invalid',
  ONESIGNAL_APP_ID: '00000000-0000-4000-8000-000000000001',
  ONESIGNAL_REST_API_KEY: 'sweep-fake-onesignal-rest-key',
  ONESIGNAL_ADMIN_APP_ID: '00000000-0000-4000-8000-000000000002',
  ONESIGNAL_ADMIN_REST_API_KEY: 'sweep-fake-onesignal-admin-key',
  NODE_ENV: 'development',
  JWT_SECRET: 'workers-test-jwt-secret-0123456789abcdef',
  SUITE_BUYER_KEY_SECRET: 'workers-test-suite-buyer-key-secret-0123456789',
  ORDER_STATUS_LINK_SECRET: 'workers-test-order-status-link-secret-0123456789',
  ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
  TAP_API_KEY: 'k',
  TAP_SECRET_KEY: 's',
  TAP_WEBHOOK_SECRET: 'dev-only-tap-webhook-secret',
  BUILD_COMMIT_SHA: 'test-sha',
  // configured so the route sweep measures the routes, not the "not configured" 503 of the alert bridge
  ALERTS_WEBHOOK_TOKEN: 'workers-test-alerts-token',
  WEB_URL: 'http://localhost:3000',
  ADMIN_URL: 'http://localhost:3001',
  API_URL: 'http://localhost:8787',
  TRUST_PROXY_HOPS: '1',
  // The dev-only POST /__dev/create-store route (src/worker.ts); never set in wrangler.jsonc.
  DEV_STATS: '1',
  // merchant-signup.test.ts posts a signup right after minting the form token (the default floor is 3 s).
  SIGNUP_MIN_FILL_MS: '0',
  // merchant-journey.test.ts: the onboarding billing step chooses InstaPay (unset = the option is refused, fail closed).
  EBDA_INSTAPAY_HANDLE: 'ebda@instapay',
  // The cutover target state (Ruling NZ-PG-8): background jobs follow each store's D1 backend flag, so a cron run hides the DO
  // stores from a sweep that is not ported and their alarms own the ported ones. The cron-tick group asserts no job reaches Postgres.
  JOBS_ON_DO: '1',
  // N-18: a store created on D1 + its DO (lib/store-create-do.ts); the pg-unreachable test creates one with Postgres dead.
  STORE_CREATE_ON_DO: '1',
  // StoreDO spike (lib/store-backend.ts): one flagged id + the operator seed secret.
  STORE_DO_ENABLED_IDS: 'spike-store-1',
  STORE_DO_SEED_TOKEN: 'workers-test-seed-token',
  // Ruling DEMO-SEED-DO-1: the demo-home operator channel (routes/demo-home.routes.ts); workers-test/demo-home.test.ts.
  DEMO_SEED_TOKEN: 'workers-test-demo-seed-token-0123456789',
  // Ruling NZ-MONEY-2: the index-retry alarm floor (30 s in production), short so money-path.test.ts watches a retry drain.
  STORE_DO_INDEX_RETRY_MS: '500',
  // The alerts webhook bridge fails closed without a token; a sweep request carries none, so it answers 401, not 503.
  ALERTS_WEBHOOK_TOKEN: 'workers-test-alerts-token',
};

// The identity service's ES256 signing key for this run (merchant-journey.test.ts signs a real `aud=store` access token with
// the private half; the accounts stub serves the public half as its JWKS, so the API verifies it exactly as in production).
const ACCOUNTS_TEST_KID = 'workers-test-accounts-key';
const accountsKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ACCOUNTS_PUBLIC_JWK = {
  ...accountsKeys.publicKey.export({ format: 'jwk' }),
  kid: ACCOUNTS_TEST_KID,
  alg: 'ES256',
  use: 'sig',
};
const ACCOUNTS_PRIVATE_JWK = {
  ...accountsKeys.privateKey.export({ format: 'jwk' }),
  kid: ACCOUNTS_TEST_KID,
};

// Two workers in one Miniflare: the BUILT API Worker (`npm run cf:dry-run`: wrangler's esbuild bundle with
// the alias block applied, i.e. exactly what would be deployed) loaded from disk, and the vitest test
// worker, which reaches it through the `API` service binding and shares its Durable Objects / KV by
// binding them with `scriptName: 'api'`. The bundle is never sent through Vite (an 11 MB module cannot
// travel over the pool's websocket, and 143k lines of Express / Prisma CJS should not be re-transformed).
export default defineConfig(async () => {
  // D1 `ebda-platform` (task 2.4): the REAL cf-schema platform migrations, applied by the test, shared by both workers.
  const platformMigrations = await readD1Migrations(
    here('../../packages/cf-schema/migrations/platform')
  );
  return {
    plugins: [
      cloudflareTest({
        main: here('./workers-test/entry.ts'),
        miniflare: {
          compatibilityDate: '2026-08-01',
          compatibilityFlags: ['nodejs_compat'],
          bindings: {
            // No Postgres in the Worker (NEON-ZERO N-17): the DB-backed describes are permanently skipped.
            E2E_DB: '0',
            TEST_PLATFORM_MIGRATIONS: platformMigrations,
            // route-sweep.test.ts: the host env does not reach workerd's process.env, so the switches travel as bindings
            SWEEP_STRICT: process.env.SWEEP_STRICT ?? '',
            SWEEP_FILTER: process.env.SWEEP_FILTER ?? '',
            ...apiVars,
            TEST_ACCOUNTS_PRIVATE_JWK: JSON.stringify(ACCOUNTS_PRIVATE_JWK),
          },
          d1Databases: { PLATFORM_DB: 'platform-db' },
          serviceBindings: { API: 'api', S3_STUB: 'gateway-stub' },
          durableObjects: {
            // Defined in the test worker itself (workers-test/entry.ts): runDurableObjectAlarm needs that.
            TEST_SCHEDULE: { className: 'TestSchedule', useSQLite: true },
            AUTH_STATE: { className: 'AuthState', scriptName: 'api', useSQLite: true },
            STORE_REALTIME: { className: 'StoreRealtime', scriptName: 'api', useSQLite: true },
            STORE_DO: { className: 'StoreDO', scriptName: 'api', useSQLite: true },
            JOB_GATE: { className: 'JobGate', scriptName: 'api', useSQLite: true },
            STORE_SCHEDULE: { className: 'StoreSchedule', scriptName: 'api', useSQLite: true },
          },
          kvNamespaces: { KV_CACHE: 'kv-cache' },
          // the same bucket the API Worker's backup sweep writes (route-sweep.test.ts reads its report)
          r2Buckets: { STORE_BACKUPS: 'store-backups' },
          // Background jobs (G5): the Workflow class and the gate DO live in the built `api` Worker.
          workflows: {
            JOBS_WORKFLOW: { name: 'ebda-jobs', className: 'JobWorkflow', scriptName: 'api' },
          },
          queueProducers: {
            EMAIL_QUEUE: { queueName: 'ebda-email' },
            EMAIL_DLQ: { queueName: 'ebda-email-dlq' },
          },
          workers: [
            {
              name: 'accounts-stub',
              modules: true,
              compatibilityDate: '2026-08-01',
              script: `
                import { WorkerEntrypoint } from 'cloudflare:workers';
                export default class extends WorkerEntrypoint {
                  async getAccountState(id) {
                    return { id, email: id + '@exit-test.invalid', emailVerified: true, mfaEnabled: id.startsWith('super-'),
                      mfaEnrolledAt: null, status: 'active', role: id.startsWith('super-') ? 'super_admin' : 'store_admin',
                      firstName: 'T', lastName: 'T', phone: null, language: 'en' };
                  }
                  async getAccountsBrief(ids) {
                    return ids.map(id => ({ id, email: id + '@exit-test.invalid', firstName: 'T', lastName: 'T', status: 'active',
                      role: id.startsWith('super-') || id.startsWith('00000000-0000-4000-8000-0000000000aa') ? 'super_admin' : 'store_admin', lastLoginAt: null, createdAt: new Date(0).toISOString() }));
                  }
                  async isRevoked() { return false; }
                  async revokeSession() {}
                  async revokeUser() {}
                  async setStatus() {}
                  async setRole() { return true; }
                  async createUser(i) { return { id: i.id }; }
                  // as the real inviteFor: an address that already has an account answers THAT account (created: false). Here an
                  // account's address is '<id>@exit-test.invalid' (getAccountState above), so a uuid local part is an existing one.
                  async inviteUser(i) {
                    const m = /^([0-9a-f-]{36})@exit-test\.invalid$/.exec(i.email);
                    return m ? { id: m[1], created: false } : { id: i.id, created: true };
                  }
                  async updateProfile(id, _i, _r, actor) {
                    // an id with this prefix is a super_admin: only that user may edit it (security tests of the admin user edit)
                    if (id.startsWith('00000000-0000-4000-8000-0000000000aa') && actor !== id) return { ok: false, code: 'FORBIDDEN_TARGET' };
                    return { ok: true };
                  }
                  async deleteStoreClients() { return { clients: 0 }; }
                  async eraseUser() { return { erased: true, remaining: 0 }; }
                  async exportUser() { return {}; }
                  async fetch() { return new Response(JSON.stringify({ keys: [${JSON.stringify(ACCOUNTS_PUBLIC_JWK)}] }), { headers: { 'content-type': 'application/json' } }); }
                }`,
            },
            {
              // The payment gateways, as the API Worker's outbound fetch sees them (workers-test/money-path.test.ts). Kashier's
              // transaction-details read (confirm-before-apply, PROVIDERS-17) answers SUCCESS for the id asked, a Fawry charge
              // answers a fresh reference number; any other call to a
              // gateway host is a 503 outage (never the real internet); everything else passes through untouched.
              name: 'gateway-stub',
              modules: true,
              compatibilityDate: '2026-08-01',
              script: `
                // An S3-compatible endpoint (R2) answering with the REAL XML shapes (workers-test/s3-xml.test.ts). Bucket 'broken'
                // answers the XML error body of a failed call. GET /__calls reports what the API Worker sent.
                const calls = [];
                const XML = { headers: { 'content-type': 'application/xml' } };
                async function s3(request, u) {
                  if (u.pathname === '/__calls') return Response.json(calls);
                  const bucket = u.pathname.split('/')[1];
                  calls.push(request.method + ' ' + u.pathname + u.search);
                  if (bucket === 'broken') return new Response('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message><RequestId>r1</RequestId></Error>', { status: 404, ...XML });
                  if (request.method === 'POST' && u.searchParams.has('delete')) {
                    const asked = [...(await request.text()).matchAll(/<Key>([^<]+)<\\/Key>/g)].map(m => m[1]);
                    return new Response('<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' + asked.map(k => '<Deleted><Key>' + k + '</Key></Deleted>').join('') + '</DeleteResult>', XML);
                  }
                  if (request.method === 'GET' && u.searchParams.get('list-type') === '2') {
                    const prefix = u.searchParams.get('prefix') || '';
                    const old = '2020-01-01T00:00:00.000Z';
                    if (u.searchParams.get('delimiter') === '/')
                      return new Response('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>' + bucket + '</Name><Prefix>stores/</Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><Delimiter>/</Delimiter><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>stores/s1/</Prefix></CommonPrefixes></ListBucketResult>', XML);
                    return new Response('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>' + bucket + '</Name><Prefix>' + prefix + '</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>stores/s1/catalogimport-a/old.xlsx</Key><LastModified>' + old + '</LastModified><ETag>&quot;e1&quot;</ETag><Size>10</Size><StorageClass>STANDARD</StorageClass></Contents><Contents><Key>stores/s1/catalogimport-a/old &amp; 2.xlsx</Key><LastModified>' + old + '</LastModified><ETag>&quot;e2&quot;</ETag><Size>20</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>', XML);
                  }
                  return new Response('', { status: 200 });
                }
                const GATEWAYS = /(^|\\.)(kashier\\.io|paymob\\.com|fawrystaging\\.com|atfawry\\.com)$/;
                export default {
                  async fetch(request) {
                    const u = new URL(request.url);
                    if (u.hostname === 's3-stub.test') return s3(request, u);
                    if (!GATEWAYS.test(u.hostname)) return fetch(request);
                    const m = u.pathname.match(/\\/v2\\/aggregator\\/transactions\\/([^/]+)$/);
                    if (m && u.hostname.endsWith('kashier.io')) {
                      const id = decodeURIComponent(m[1]);
                      return Response.json({ status: 'SUCCESS', body: { transactionId: id, status: 'SUCCESS', trxType: 'pay',
                        transactions: [{ transactionId: id, operation: 'pay', status: 'SUCCESS' }] } });
                    }
                    // Fawry PayAtFawry charge: a fresh reference number per call (a second call = a second live reference)
                    if (u.pathname.endsWith('/ECommerceWeb/Fawry/payments/charge') && request.method === 'POST')
                      return Response.json({ statusCode: 200, statusDescription: 'Operation done successfully',
                        referenceNumber: String(Math.floor(1e8 + Math.random() * 9e8)) });
                    return Response.json({ message: 'gateway stub: not answered' }, { status: 503 });
                  }
                }`,
            },
            {
              name: 'api',
              outboundService: 'gateway-stub',
              modulesRoot: here('./dist-cf'),
              modules: [
                { type: 'ESModule', path: BUNDLE },
                ...readdirSync(here('./dist-cf'))
                  .filter(f => f.endsWith('.wasm'))
                  .map(f => ({ type: 'CompiledWasm' as const, path: here(`./dist-cf/${f}`) })),
                // the separate Worker modules the deploy uploads (wrangler `rules`, Rulings BUNDLE-BUDGET-7/10): without them
                // `import('./cf/modules/exceljs.cjs')` has nothing to load and the xlsx routes answer 500
                ...(existsSync(here('./dist-cf/cf/modules'))
                  ? readdirSync(here('./dist-cf/cf/modules')).flatMap(f =>
                      f.endsWith('.mjs') || f.endsWith('.cjs')
                        ? [
                            {
                              type: (f.endsWith('.cjs') ? 'CommonJS' : 'ESModule') as
                                | 'CommonJS'
                                | 'ESModule',
                              path: here(`./dist-cf/cf/modules/${f}`),
                            },
                          ]
                        : []
                    )
                  : []),
              ],
              compatibilityDate: '2026-08-01',
              compatibilityFlags: ['nodejs_compat'],
              bindings: {
                ...apiVars,
                // an S3-compatible endpoint answered by gateway-stub (workers-test/s3-xml.test.ts)
                STORAGE_ENDPOINT: 'https://s3-stub.test',
                STORAGE_ACCESS_KEY: 'k',
                STORAGE_SECRET_KEY: 's',
                STORAGE_BUCKET: 'uploads',
                STORAGE_PRIVATE_BUCKET: 'private',
              },
              kvNamespaces: { KV_CACHE: 'kv-cache' },
              // The private bucket of the nightly backup sweep (cf/ops/backup-sweep.ts, G8).
              r2Buckets: { STORE_BACKUPS: 'store-backups' },
              d1Databases: { PLATFORM_DB: 'platform-db' },
              durableObjects: {
                AUTH_STATE: { className: 'AuthState', useSQLite: true },
                STORE_REALTIME: { className: 'StoreRealtime', useSQLite: true },
                STORE_DO: { className: 'StoreDO', useSQLite: true },
                JOB_GATE: { className: 'JobGate', useSQLite: true },
                STORE_SCHEDULE: { className: 'StoreSchedule', useSQLite: true },
              },
              workflows: {
                JOBS_WORKFLOW: { name: 'ebda-jobs', className: 'JobWorkflow' },
              },
              // The identity service (Service Binding ACCOUNTS): the route sweep needs the account facts (MFA enrolled, active)
              // that the real one answers from D1 `ebda-identity`. A user named `super-*` is an enrolled platform admin.
              serviceBindings: { ACCOUNTS: 'accounts-stub' },
              queueProducers: {
                EMAIL_QUEUE: { queueName: 'ebda-email' },
                SMS_QUEUE: { queueName: 'ebda-sms' },
                JOBS_QUEUE: { queueName: 'ebda-jobs' },
                // Store -> Ebda Chat events (lib/wa/events.ts throws without it, by design)
                WA_EVENTS_QUEUE: { queueName: 'ebda-wa-events' },
              },
              // The consumers of wrangler.jsonc, with the retry delay shortened so a test can watch a
              // message travel main queue -> retry -> dead-letter queue -> the replay list in seconds.
              queueConsumers: {
                'ebda-email': {
                  maxBatchSize: 1,
                  maxBatchTimeout: 0,
                  maxRetries: 1,
                  retryDelay: 1,
                  deadLetterQueue: 'ebda-email-dlq',
                },
                'ebda-email-dlq': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1 },
              },
            },
          ],
        },
      }),
    ],
    resolve: {
      // The test worker bundles workspace packages from source (as wrangler.jsonc's alias block does for the API
      // Worker); without it `@ebda/shared` resolves to ./dist/index.js, which exists only after a build.
      alias: [
        { find: '@ebda/shared/observe', replacement: here('../../packages/shared/src/observe-kit.ts') },
        { find: '@ebda/shared/wa-v1', replacement: here('../../packages/shared/src/foundation/contracts/wa-v1.ts') },
        { find: '@ebda/shared/request-guard', replacement: here('../../packages/shared/src/foundation/request-guard.ts') },
        { find: '@ebda/shared', replacement: here('../../packages/shared/src/index.ts') },
        // the same swap as wrangler.jsonc's alias block: the SDK's DOM-free XML parser (a Worker has no DOMParser).
        // Exact match only: the stub itself imports @aws-sdk/xml-builder/dist-es/* subpaths.
        { find: /^@aws-sdk\/xml-builder$/, replacement: here('./src/cf/stubs/aws-xml-builder.ts') },
      ],
    },
    test: {
      globalSetup: ['../../tests/global-setup-assistant-assets.ts'],
      include: ['workers-test/**/*.test.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  };
});
