import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Tests run INSIDE workerd (Miniflare) against the real Worker and a real SQLite-backed
// Durable Object. Nothing is mocked except outbound probe fetches, which each test controls.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { STATUS_SECRET: 'test-secret' } },
    }),
  ],
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
