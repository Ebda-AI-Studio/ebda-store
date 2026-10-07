import { defineConfig, devices } from '@playwright/test';

// Dahab template (builder Phase 3 pilot) browser checks against a running
// Dahab demo store: the isolated preview (default) or a local stack
// (DAHAB_BASE_URL=http://dahab-preview.ebda.app:3071 DAHAB_MAP=127.0.0.1).
// Not part of CI: it needs the seeded demo store (scripts/dahab-demo).
const BASE = process.env.DAHAB_BASE_URL ?? 'https://dahab-preview.ebda.app';
const host = new URL(BASE).hostname;
const launchOptions = process.env.DAHAB_MAP
  ? {
      args: [
        `--host-resolver-rules=MAP ${host} ${process.env.DAHAB_MAP}`,
        '--disable-web-security',
      ],
    }
  : {};

export default defineConfig({
  testDir: './tests/dahab',
  fullyParallel: true,
  retries: 0,
  workers: 3,
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL: BASE, navigationTimeout: 60_000, launchOptions },
  projects: [
    {
      name: 'phone-390',
      use: {
        ...devices['iPhone 14'],
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
      },
    },
    {
      name: 'tablet-820',
      use: {
        browserName: 'chromium',
        viewport: { width: 820, height: 1180 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop-1440',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      },
    },
  ],
});
