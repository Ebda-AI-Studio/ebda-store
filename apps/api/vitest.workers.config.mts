import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { createConnection } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Is the local database path (Postgres behind pgbouncer, apps/api/scripts/cf-pooler.sh) up? The
 * tests that need a database run only then; the Durable Object / limiter / entry tests never do.
 */
async function dbReachable(): Promise<boolean> {
  const { hostname, port } = new URL(LOCAL_DB);
  return new Promise(resolve => {
    const s = createConnection({ host: hostname, port: Number(port) });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// The local dev path of apps/api/scripts/cf-pooler.sh: the non-bypass role through pgbouncer. The password
// is the repo-wide fake one (CI role step, tests/integration/rls-*.test.ts); roles are cluster-wide.
// EBDA_WORKERS_TEST_DB_URL points the DB-backed tests at another pooler / database (a host with several
// concurrent runs: each takes its own pgbouncer), default = the cf-pooler.sh one.
const LOCAL_DB =
  process.env.EBDA_WORKERS_TEST_DB_URL ||
  ['postgresql://ebda_app', process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw'].join(':') +
    '@127.0.0.1:6433/ebda_s1';

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
  // configured so the route sweep measures the routes, not the "not configured" 503 of the alert bridge
  ALERTS_WEBHOOK_TOKEN: 'workers-test-alerts-token',
  WEB_URL: 'http://localhost:3000',
  ADMIN_URL: 'http://localhost:3001',
  API_URL: 'http://localhost:8787',
  TRUST_PROXY_HOPS: '1',
  // The dev-only /__dev/stats and /__dev/probe routes (src/cf/dev-stats.ts); never set in wrangler.jsonc.
  DEV_STATS: '1',
  // N-18: a store created on D1 + its DO (lib/store-create-do.ts); the pg-unreachable test creates one with Postgres dead.
  STORE_CREATE_ON_DO: '1',
  // StoreDO spike (lib/store-backend.ts): one flagged id + the operator seed secret.
  STORE_DO_ENABLED_IDS: 'spike-store-1',
  STORE_DO_SEED_TOKEN: 'workers-test-seed-token',
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
            E2E_DB: (await dbReachable()) ? '1' : '0',
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
              hyperdrives: {
                HYPERDRIVE: LOCAL_DB,
              },
              queueProducers: {
                EMAIL_QUEUE: { queueName: 'ebda-email' },
                SMS_QUEUE: { queueName: 'ebda-sms' },
                JOBS_QUEUE: { queueName: 'ebda-jobs' },
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
