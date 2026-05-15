import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // `.claude/worktrees/**` houses temporary git worktrees from
    // subagent runs; their stale tests would otherwise be picked up
    // and either fail (missing deps) or duplicate the live tests.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.claude/**'],
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
        // Initial gate at 30% — surfaces coverage drops without blocking
        // ongoing PRs while the suite is small. Ratchet up by ~5 points
        // per quarter as tests grow. CI passes `--coverage` so the
        // threshold enforces; without --coverage vitest skips it entirely.
        lines: 30,
        functions: 30,
        branches: 30,
        statements: 30,
      },
    },
    setupFiles: ['./tests/setup.ts', './tests/setup-e2e.ts'],
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
