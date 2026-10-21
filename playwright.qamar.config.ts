import { defineConfig, devices } from '@playwright/test';

// Qamar looks (Phase B1 Task 10): scenario matrix + demo-bar checks against a LOCAL stack.
// Needs the seeded stores: scripts/storedemo/seed.mjs --local-look-stores and
// scripts/storedemo/scenario-stores.mjs, and the host->store dev proxy on QAMAR_PORT
// (store hosts are <slug>.localhost:<port>). Not part of CI.
const PORT = process.env.QAMAR_PORT ?? '3100';
const BASE = process.env.QAMAR_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/qamar',
  fullyParallel: true,
  retries: 0,
  workers: Number(process.env.QAMAR_WORKERS ?? 2),
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: BASE, navigationTimeout: 90_000 },
  projects: [
    {
      name: 'phone-390',
      use: {
        ...devices['iPhone 14'],
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'tablet-820',
      use: {
        browserName: 'chromium',
        viewport: { width: 820, height: 1180 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
