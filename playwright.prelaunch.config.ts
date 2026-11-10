import { defineConfig, devices } from '@playwright/test';

// Pre-launch test program (docs/testing/prelaunch-program.md). Runs against PRODUCTION by default,
// on the dedicated QA store only (PRELAUNCH_STORE_SLUG, default ameliaaurum = the Amelia Aurum QA store, Ruling DOMAIN-TEST-2). Read-only unless
// PRELAUNCH_WRITE=1, which lets the journey place COD orders on the QA store and cancel them after.
const STORE = process.env.PRELAUNCH_STORE_SLUG ?? 'ameliaaurum';
export const STOREFRONT_URL = process.env.PRELAUNCH_STOREFRONT_URL ?? `https://${STORE}.ebda.app`;

export default defineConfig({
  testDir: './tests/prelaunch',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.PRELAUNCH_JSON ?? 'prelaunch-results/results.json' }],
  ],
  outputDir: 'prelaunch-results/artifacts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: STOREFRONT_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
