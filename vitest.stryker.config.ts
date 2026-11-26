/**
 * Vitest config for Stryker mutation testing — excludes the e2e DB setup
 * file that guards against running against prod Neon. Unit tests under
 * tests/unit/ only mock Prisma and have no DB dependency.
 */
import { defineConfig } from 'vitest/config';
import { perAppAtAlias, workspaceAliases } from './vitest.shared';

export default defineConfig({
  // Mirrors vitest.config.ts — WITHOUT these, `'@/...'` inside an app resolved
  // to the repo root here and three unit test files silently ran against the
  // wrong modules, deflating every Stryker score they contribute to.
  oxc: {
    jsx: 'automatic',
  },
  plugins: [perAppAtAlias()],
  test: {
    globalSetup: ['./tests/global-setup-assistant-assets.ts'],
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/stryker-tmp/**'],
    // Only load global setup — NOT setup-e2e.ts (which blocks without TEST_DATABASE_URL)
    setupFiles: ['./tests/setup-git-env.ts', './tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    maxWorkers: 2,
    retry: 0,
  },
  resolve: {
    alias: workspaceAliases(__dirname),
  },
});
