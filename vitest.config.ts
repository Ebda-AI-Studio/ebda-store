import { defineConfig } from 'vitest/config';
import { perAppAtAlias, workspaceAliases } from './vitest.shared';

export default defineConfig({
  // Every app's tsconfig sets `"jsx": "preserve"` (Next.js/its own bundler
  // owns the JSX transform at build time) — Vite's oxc transform reads that
  // same tsconfig for test transforms and, left on "preserve", leaves raw
  // JSX in the module body for the next pipeline stage to choke on. Force
  // oxc's own transform for test runs only; production builds are untouched.
  oxc: {
    jsx: 'automatic',
  },
  plugins: [perAppAtAlias()],
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // `.claude/worktrees/**` houses temporary git worktrees from
    // subagent runs; their stale tests would otherwise be picked up
    // and either fail (missing deps) or duplicate the live tests.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.claude/**', 'tests/smoke/**'],
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
        // Initial gate at 23% — surfaces coverage drops without blocking
        // ongoing PRs while the suite is small. Ratchet up by ~5 points
        // per quarter as tests grow. CI passes `--coverage` so the
        // threshold enforces; without --coverage vitest skips it entirely.
        // Lowered from 30% after adding audit scripts (hard to unit test)
        lines: 24,
        functions: 23,
        branches: 21,
        statements: 23,
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
    // Single source of truth — see vitest.shared.ts for why there is no
    // bare '@' entry, and what drifting from it silently broke.
    alias: workspaceAliases(__dirname),
  },
});
