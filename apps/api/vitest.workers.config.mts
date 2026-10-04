import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { createConnection } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Is the local database path (Postgres behind pgbouncer, apps/api/scripts/cf-pooler.sh) up? The
 * tests that need a database run only then; the Durable Object / limiter / entry tests never do.
 */
async function dbReachable(): Promise<boolean> {
  return new Promise(resolve => {
    const s = createConnection({ host: '127.0.0.1', port: 6433 });
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
const LOCAL_DB =
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
  ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
  TAP_API_KEY: 'k',
  TAP_SECRET_KEY: 's',
  TAP_WEBHOOK_SECRET: 'dev-only-tap-webhook-secret',
  BUILD_COMMIT_SHA: 'test-sha',
  WEB_URL: 'http://localhost:3000',
  ADMIN_URL: 'http://localhost:3001',
  API_URL: 'http://localhost:8787',
  TRUST_PROXY_HOPS: '1',
};

// Two workers in one Miniflare: the BUILT API Worker (`npm run cf:dry-run`: wrangler's esbuild bundle with
// the alias block applied, i.e. exactly what would be deployed) loaded from disk, and the vitest test
// worker, which reaches it through the `API` service binding and shares its Durable Objects / KV by
// binding them with `scriptName: 'api'`. The bundle is never sent through Vite (an 11 MB module cannot
// travel over the pool's websocket, and 143k lines of Express / Prisma CJS should not be re-transformed).
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      main: here('./workers-test/entry.ts'),
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: { E2E_DB: (await dbReachable()) ? '1' : '0', ...apiVars },
        serviceBindings: { API: 'api' },
        durableObjects: {
          AUTH_STATE: { className: 'AuthState', scriptName: 'api', useSQLite: true },
          STORE_REALTIME: { className: 'StoreRealtime', scriptName: 'api', useSQLite: true },
        },
        kvNamespaces: { KV_CACHE: 'kv-cache' },
        queueProducers: {
          EMAIL_QUEUE: { queueName: 'ebda-email' },
          EMAIL_DLQ: { queueName: 'ebda-email-dlq' },
        },
        workers: [
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
            durableObjects: {
              AUTH_STATE: { className: 'AuthState', useSQLite: true },
              STORE_REALTIME: { className: 'StoreRealtime', useSQLite: true },
            },
            hyperdrives: {
              HYPERDRIVE: LOCAL_DB,
            },
            queueProducers: {
              EMAIL_QUEUE: { queueName: 'ebda-email' },
              SMS_QUEUE: { queueName: 'ebda-sms' },
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
  test: {
    include: ['workers-test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
