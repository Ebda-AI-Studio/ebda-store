/**
 * Vitest config for Stryker mutation testing — excludes the e2e DB setup
 * file that guards against running against prod Neon. Unit tests under
 * tests/unit/ only mock Prisma and have no DB dependency.
 */
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/stryker-tmp/**'],
    // Only load global setup — NOT setup-e2e.ts (which blocks without TEST_DATABASE_URL)
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    maxWorkers: 2,
    retry: 0,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      '@api': path.resolve(__dirname, './apps/api/src'),
      '@web': path.resolve(__dirname, './apps/web/src'),
      '@admin': path.resolve(__dirname, './apps/admin/src'),
      '@database': path.resolve(__dirname, './packages/database'),
      '@shared': path.resolve(__dirname, './packages/shared'),
    },
  },
});
