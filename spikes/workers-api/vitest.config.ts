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
  resolve: {
    // pg-protocol ships esm/index.js (no "type":"module") that Vite's `import` condition picks while
    // pg itself require()s it -> "Cannot use import statement outside a module" in workerd.
    // Force the CJS build.
    alias: {
      'pg-protocol': new URL('./node_modules/pg-protocol/dist/index.js', import.meta.url).pathname,
      // `default` condition resolves to dist/empty.js (no workerd condition in Vite's resolver) => CloudflareSocket undefined.
      'pg-cloudflare': new URL('./node_modules/pg-cloudflare/dist/index.js', import.meta.url).pathname,
    },
  },
  test: {
    testTimeout: 60_000, hookTimeout: 30_000, include: ['test/**/*.test.ts'] },
});
