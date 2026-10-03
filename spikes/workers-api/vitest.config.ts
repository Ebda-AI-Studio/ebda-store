import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Tests run INSIDE workerd (Miniflare) against the real Worker + a real Hyperdrive
// binding (localConnectionString -> pgbouncer:6432 -> postgres).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { DEBUG_HEADERS: '1' } },
    }),
  ],
  test: { testTimeout: 60_000, hookTimeout: 30_000, include: ['test/**/*.test.ts'] },
});
