import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * G11: the DB-less integration lane. Real StoreDO (SQLite), D1 and R2 bindings on local workerd
 * (Miniflare), no Postgres, no built bundle. Runs on the Umbra runner via `npm run cf:test:do -w apps/api`
 * (CI job `workerd-integration`). The lane that DOES need Postgres + the built Worker stays
 * vitest.workers.config.mts (`cf:test`).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: here('./workers-do/entry.ts'),
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat'],
        // N-9: envelope key for the encrypted customer-credential backup (test value only)
        bindings: { CUSTOMER_AUTH_BACKUP_KEY: Buffer.alloc(32, 7).toString('base64') },
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
      '@ebda/shared': here('../../packages/shared/src/index.ts'),
      '@ebda-src/repo': here('../../packages/repo/src/index.ts'),
      '@ebda-src/cf-schema': here('../../packages/cf-schema/src/store/migrations.generated.ts'),
      '@ebda-src/prisma-meta': here('../../packages/cf-schema/generated/prisma-meta.json'),
    },
  },
  test: {
    include: ['workers-do/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
