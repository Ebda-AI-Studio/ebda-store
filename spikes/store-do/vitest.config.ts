import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { STORE_DO_ENABLED_IDS: 'store-a,store-b', SEED_TOKEN: 'test-seed-token' },
      },
    }),
  ],
  test: { testTimeout: 30_000, include: ['test/**/*.test.ts'] },
});
