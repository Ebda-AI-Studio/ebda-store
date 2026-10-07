import { defineConfig, devices } from '@playwright/test';

/**
 * Visual builder E2E (Phase 2): the admin editor, driven in a real browser
 * against an in-memory API (tests/builder-e2e/mock-api.mjs) and a contract
 * fake of the storefront canvas, in Arabic (RTL) and English at the three
 * builder widths 390 / 820 / 1280. Local + CI-runnable; never touches a real
 * store or Neon.
 *
 *   npx playwright test -c playwright.builder.config.ts
 */
const ADMIN_PORT = Number(process.env.BUILDER_E2E_ADMIN_PORT || 3101);
const API_PORT = Number(process.env.MOCK_API_PORT || 4510);

const sizes = [
  { name: '390', viewport: { width: 390, height: 844 } },
  { name: '820', viewport: { width: 820, height: 1180 } },
  { name: '1280', viewport: { width: 1280, height: 800 } },
];
const locales = ['ar', 'en'] as const;

export default defineConfig({
  testDir: './tests/builder-e2e',
  // `.e2e.ts`, not `.spec.ts`: vitest's root include collects every *.spec.ts.
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${ADMIN_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: locales.flatMap(locale =>
    sizes.map(s => ({
      name: `${locale}-${s.name}`,
      use: {
        ...devices['Desktop Chrome'],
        viewport: s.viewport,
        locale: locale === 'ar' ? 'ar-EG' : 'en-US',
      },
      metadata: { locale },
    }))
  ),
  webServer: [
    {
      command: `node tests/builder-e2e/mock-api.mjs`,
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_API_PORT: String(API_PORT) },
    },
    {
      command: `npx next dev -p ${ADMIN_PORT}`,
      cwd: 'apps/admin',
      port: ADMIN_PORT,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
      env: { NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
