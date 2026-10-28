import { defineConfig } from 'vitest/config';
import { perAppAtAlias, workspaceAliases } from './vitest.shared';

export default defineConfig({
  // Defence in depth with the per-runner TMPDIR (ci.yml "Private TMPDIR per runner"): on CI the Vite/Vitest
  // cache lives in this runner's private RUNNER_TEMP, never in a directory another runner's job can touch.
  cacheDir: process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/vitest-cache` : undefined,
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
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.claude/**',
      'tests/smoke/**',
      // apps/status runs on workerd via @cloudflare/vitest-pool-workers (npm run test:status).
      'apps/status/**',
      // apps/accounts runs on workerd with a local D1 (npm run test:accounts).
      'apps/accounts/**',
      // packages/repo/workers-test runs prisma-lite on a real Durable Object (workerd): npm run test:repo-workers.
      'packages/repo/workers-test/**',
      // apps/api/workers-test runs the BUILT Worker on workerd via @cloudflare/vitest-pool-workers
      // (npm run cf:test -w apps/api).
      'apps/api/workers-test/**',
      // apps/api/workers-do runs the real StoreDO + D1 + R2 on local workerd (npm run cf:test:do -w apps/api).
      'apps/api/workers-do/**',
      // Playwright specs (their own playwright.<name>.config.ts), not vitest: collecting them throws
      // "Playwright Test did not expect test() to be called here" and failed `vitest list` in the
      // Orphan test coverage job (Ruling ITEST-3).
      'tests/{dahab,jasmine,lamma,marketing-layout,qamar,souq}/**',
      // spikes/* are self-contained packages with their own vitest config (workerd pool: `cloudflare:test`).
      'spikes/**',
    ],
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
    // No retry by default (#1248): a global `retry: 1` let a retry re-run
    // ONLY the failures of an order-dependent unit test against an
    // already-drained mock queue, going green while the attempt-1 failure
    // was the real defect (5 bank-reconciliation tests, fixed 2026-09-02).
    // That masking landed on the required "Unit Tests" CI job, which uses
    // this root config with no override, so masking a state-pollution bug
    // there merged silently. Genuinely network-flaky tiers (integration,
    // e2e) re-enable retry with a per-invocation `--retry=1` in ci.yml
    // instead of a blanket default here.
    retry: 0,
  },
  resolve: {
    // Single source of truth — see vitest.shared.ts for why there is no
    // bare '@' entry, and what drifting from it silently broke.
    alias: workspaceAliases(__dirname),
  },
});
