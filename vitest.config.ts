import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '.next/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/coverage/**',
      ],
      thresholds: {
        // Reduced thresholds for initial implementation
        lines: 50,
        functions: 50,
        branches: 50,
        statements: 50,
      },
    },
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run integration tests sequentially to avoid port conflicts
    pool: 'forks',
    maxWorkers: 1,
    // Retry failing tests once (useful for flaky network tests)
    retry: 1,
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
