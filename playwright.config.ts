import { defineConfig, devices } from '@playwright/test';

const STOREFRONT_BASE_URL = process.env.SMOKE_STOREFRONT_URL ?? 'https://wadyaljuz.com';
const ADMIN_BASE_URL = process.env.SMOKE_ADMIN_URL ?? 'https://app.forcemediakw.com';

export default defineConfig({
  testDir: './tests/smoke',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 8_000,
    navigationTimeout: 20_000,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: false,
  },
  projects: [
    // Chromium (Desktop Chrome)
    {
      name: 'storefront',
      testMatch: /storefront.*\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: STOREFRONT_BASE_URL },
    },
    {
      name: 'admin',
      testMatch: /admin.*\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: ADMIN_BASE_URL },
    },
    // Firefox
    {
      name: 'storefront-firefox',
      testMatch: /storefront.*\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'], baseURL: STOREFRONT_BASE_URL },
    },
    {
      name: 'admin-firefox',
      testMatch: /admin.*\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'], baseURL: ADMIN_BASE_URL },
    },
    // WebKit (Desktop Safari)
    {
      name: 'storefront-webkit',
      testMatch: /storefront.*\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Safari'], baseURL: STOREFRONT_BASE_URL },
    },
    {
      name: 'admin-webkit',
      testMatch: /admin.*\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Safari'], baseURL: ADMIN_BASE_URL },
    },
    // Mobile Safari (iPhone 14 — primary Kuwait market browser)
    {
      name: 'storefront-mobile-safari',
      testMatch: /storefront.*\.smoke\.spec\.ts$/,
      use: { ...devices['iPhone 14'], baseURL: STOREFRONT_BASE_URL },
    },
  ],
});
