import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// prisma-lite on a REAL Durable Object (workerd). Run: npm run cf:test -w packages/repo
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './workers-test/wrangler.jsonc' } })],
  test: { testTimeout: 30_000, include: ['workers-test/test/**/*.test.ts'] },
});
