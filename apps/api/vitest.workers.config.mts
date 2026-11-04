import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const BUNDLE = here('./dist-cf/worker.js');
if (!existsSync(BUNDLE)) {
  throw new Error(
    'dist-cf/worker.js is missing: run `npm run -w apps/api cf:dry-run` first (cf:test does)'
  );
}

const apiVars = {
  NODE_ENV: 'development',
  JWT_SECRET: 'workers-test-jwt-secret-0123456789abcdef',
  SUITE_BUYER_KEY_SECRET: 'workers-test-suite-buyer-key-secret-0123456789',
  ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
  TAP_API_KEY: 'k',
  TAP_SECRET_KEY: 's',
  TAP_WEBHOOK_SECRET: 'dev-only-tap-webhook-secret',
  BUILD_COMMIT_SHA: 'test-sha',
  WEB_URL: 'http://localhost:3000',
  ADMIN_URL: 'http://localhost:3001',
  API_URL: 'http://localhost:8787',
  TRUST_PROXY_HOPS: '1',
  // The dev-only POST /__dev/create-store route (src/worker.ts); never set in wrangler.jsonc.
  DEV_STATS: '1',
  // N-18: a store created on D1 + its DO (lib/store-create-do.ts); the pg-unreachable test creates one with Postgres dead.
  STORE_CREATE_ON_DO: '1',
  // StoreDO spike (lib/store-backend.ts): one flagged id + the operator seed secret.
  STORE_DO_ENABLED_IDS: 'spike-store-1',
  STORE_DO_SEED_TOKEN: 'workers-test-seed-token',
  // The alerts webhook bridge fails closed without a token; a sweep request carries none, so it answers 401, not 503.
  ALERTS_WEBHOOK_TOKEN: 'workers-test-alerts-token',
};

// Two workers in one Miniflare: the BUILT API Worker (`npm run cf:dry-run`: wrangler's esbuild bundle with
// the alias block applied, i.e. exactly what would be deployed) loaded from disk, and the vitest test
// worker, which reaches it through the `API` service binding and shares its Durable Objects / KV by
// binding them with `scriptName: 'api'`. The bundle is never sent through Vite (an 11 MB module cannot
// travel over the pool's websocket, and 143k lines of Express / Prisma CJS should not be re-transformed).
// The route sweep (workers-test/route-sweep.test.ts) runs with a stand-in identity service behind `ACCOUNTS`; no other test does.
const WITH_ACCOUNTS = process.argv.some(a => a.includes('route-sweep'));

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
          },
          d1Databases: { PLATFORM_DB: 'platform-db' },
          serviceBindings: { API: 'api' },
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
          // Background jobs (G5): the Workflow class and the gate DO live in the built `api` Worker.
          workflows: {
            JOBS_WORKFLOW: { name: 'ebda-jobs', className: 'JobWorkflow', scriptName: 'api' },
          },
          queueProducers: {
            EMAIL_QUEUE: { queueName: 'ebda-email' },
            EMAIL_DLQ: { queueName: 'ebda-email-dlq' },
          },
          workers: [
            ...(WITH_ACCOUNTS
              ? [
                  {
                    name: 'accounts',
                    modulesRoot: here('./workers-test/fakes'),
                    modules: [
                      {
                        type: 'ESModule' as const,
                        path: here('./workers-test/fakes/accounts.mjs'),
                      },
                    ],
                    compatibilityDate: '2026-08-01',
                    compatibilityFlags: ['nodejs_compat'],
                  },
                ]
              : []),
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
                      role: id.startsWith('super-') ? 'super_admin' : 'store_admin', lastLoginAt: null, createdAt: new Date(0).toISOString() }));
                  }
                  async isRevoked() { return false; }
                  async revokeSession() {}
                  async revokeUser() {}
                  async setStatus() {}
                  async setRole() { return true; }
                  async deleteStoreClients() { return { clients: 0 }; }
                  async eraseUser() { return { erased: true, remaining: 0 }; }
                  async exportUser() { return {}; }
                  async fetch() { return new Response(JSON.stringify({ keys: [] }), { headers: { 'content-type': 'application/json' } }); }
                }`,
            },
            {
              name: 'api',
              modulesRoot: here('./dist-cf'),
              modules: [
                { type: 'ESModule', path: BUNDLE },
                ...readdirSync(here('./dist-cf'))
                  .filter(f => f.endsWith('.wasm'))
                  .map(f => ({ type: 'CompiledWasm' as const, path: here(`./dist-cf/${f}`) })),
              ],
              compatibilityDate: '2026-08-01',
              compatibilityFlags: ['nodejs_compat'],
              bindings: apiVars,
              kvNamespaces: { KV_CACHE: 'kv-cache' },
              // The private bucket of the nightly backup sweep (cf/ops/backup-sweep.ts, G8).
              r2Buckets: { STORE_BACKUPS: 'store-backups' },
              d1Databases: { PLATFORM_DB: 'platform-db' },
              ...(WITH_ACCOUNTS ? { serviceBindings: { ACCOUNTS: 'accounts' } } : {}),
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
      alias: { '@ebda/shared': here('../../packages/shared/src/index.ts') },
    },
    test: {
      include: ['workers-test/**/*.test.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  };
});
