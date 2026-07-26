import { defineConfig, type Plugin } from 'vitest/config';
import path from 'path';

/**
 * Each app (`apps/api`, `apps/admin`, `apps/web`, `apps/orders`) declares its
 * OWN `"@/*": ["./src/*"]` path in its own tsconfig.json — `@/lib/x` inside
 * `apps/web` means `apps/web/src/lib/x`, NOT the same path inside `apps/admin`.
 * A single flat string alias can't serve every app's `'@/'` convention at
 * once (it has no way to know which app an import came from), so this
 * resolves `'@/...'` relative to the nearest `apps/<name>/src/` ancestor of
 * the IMPORTING file. Previously any transitive `'@/...'` import inside an
 * app's source tree was unresolvable under the shared root Vitest config —
 * `apps/web/src/app/products/[slug]/ProductDetailBody.test.tsx` was the
 * first test to actually import a chain that hit one.
 */
function perAppAtAlias(): Plugin {
  const apps = ['api', 'admin', 'web', 'orders'];
  return {
    name: 'per-app-at-alias',
    async resolveId(source, importer) {
      if (!importer || !source.startsWith('@/')) return null;
      const normalizedImporter = importer.replace(/\\/g, '/');
      for (const app of apps) {
        const marker = `/apps/${app}/src/`;
        const idx = normalizedImporter.indexOf(marker);
        if (idx === -1) continue;
        const appSrcRoot = normalizedImporter.slice(0, idx + marker.length);
        const rewritten = path.join(appSrcRoot, source.slice(2));
        return this.resolve(rewritten, importer, { skipSelf: true });
      }
      return null;
    },
  };
}

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
    alias: {
      // NOTE: no bare `'@'` → repo-root alias here (deliberately removed —
      // nothing in the repo imports it, and its prefix-match on `'@/...'`
      // fired ahead of every app's own `'@/'` convention, corrupting them
      // to a nonexistent repo-root path before `perAppAtAlias()` above ever
      // saw the original specifier). Vite's `resolve.alias` plugin runs
      // before ALL user plugins regardless of `enforce`, so the only fix
      // was removing the colliding key.
      '@api': path.resolve(__dirname, './apps/api/src'),
      '@web': path.resolve(__dirname, './apps/web/src'),
      '@admin': path.resolve(__dirname, './apps/admin/src'),
      '@database': path.resolve(__dirname, './packages/database'),
      '@shared': path.resolve(__dirname, './packages/shared'),
    },
  },
});
