import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * G11: the DB-less integration lane. Real StoreDO (SQLite), D1 and R2 bindings on local workerd
 * (Miniflare), no Postgres, no built bundle. Runs on the Umbra runner via `npm run cf:test:do -w apps/api`
 * (CI job `workerd-integration`). The lane that DOES need Postgres + the built Worker stays
 * vitest.workers.config.mts (`cf:test`).
 */
export default defineConfig(async () => {
  // hub-fanout.test.ts: the REAL platform D1 schema (the directory the super-admin fan-out reads), applied by the test.
  const platformMigrations = await readD1Migrations(
    here('../../packages/cf-schema/migrations/platform')
  );
  return {
    plugins: [
      cloudflareTest({
        main: here('./workers-do/entry.ts'),
        miniflare: {
          compatibilityDate: '2026-08-01',
          compatibilityFlags: ['nodejs_compat'],
          // N-9: envelope key for the encrypted customer-credential backup (test value only)
          bindings: {
            CUSTOMER_AUTH_BACKUP_KEY: Buffer.alloc(32, 7).toString('base64'),
            TEST_PLATFORM_MIGRATIONS: platformMigrations,
          },
          durableObjects: { STORE_DO: { className: 'StoreDO', useSQLite: true } },
          r2Buckets: ['STORE_BACKUPS', 'MEDIA_BUCKET', 'CI_BUCKET'],
          d1Databases: ['PLATFORM_DB', 'IDENTITY_DB', 'RESTORE_DB'],
          kvNamespaces: ['KV_CACHE'],
        },
      }),
    ],
    resolve: {
      // Workspace packages bundle from source, as in wrangler.jsonc's alias block.
      alias: {
        // the engine subpath first: an alias is a prefix match, and `@ebda/shared` points at a FILE
        '@ebda/shared/smart-layer': here('../../packages/shared/src/smart-layer-kit.ts'),
        '@ebda/shared/observe': here('../../packages/shared/src/observe-kit.ts'),
        '@ebda/shared/wa-v1': here('../../packages/shared/src/foundation/contracts/wa-v1.ts'),
        '@ebda/shared/request-guard': here('../../packages/shared/src/foundation/request-guard.ts'),
        '@ebda/shared/web-search': here('../../packages/shared/src/web-search-kit.ts'),
        '@ebda/shared': here('../../packages/shared/src/index.ts'),
        // hub-fanout.test.ts imports lib/platform-hub (-> billing-d1 -> @ebda/database): from SOURCE, as wrangler.jsonc does,
        // never the CommonJS dist (whose `pg` cannot load on workerd).
        ioredis: here('./src/cf/stubs/ioredis.ts'),
        pg: here('./workers-do/stubs/pg.ts'),
        '@ebda/database': here('../../packages/database/src/index.ts'),
        '@ebda-src/repo': here('../../packages/repo/src/index.ts'),
        '@ebda-src/cf-schema': here('../../packages/cf-schema/src/store/migrations.generated.ts'),
        '@ebda-src/prisma-meta': here('../../packages/cf-schema/generated/prisma-meta.json'),
      },
    },
    test: {
      globalSetup: ['../../tests/global-setup-assistant-assets.ts'],
      include: ['workers-do/**/*.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
