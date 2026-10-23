import { defineConfig, devices } from '@playwright/test';

// Qamar looks (Phase B1 Task 10): scenario matrix + demo-bar checks against a LOCAL stack.
// Needs the seeded stores: scripts/storedemo/seed.mjs --local-look-stores and
// scripts/storedemo/scenario-stores.mjs, and the host->store dev proxy on QAMAR_PORT
// (store hosts are <slug>.localhost:<port>). Against a PRODUCTION web build (refuses .localhost hosts)
// give the stores a custom domain and set QAMAR_HOST_BASE=localhost-b5.test (same trick as
// playwright.dahab.config.ts; `scripts/dahab-demo/seed-local-hosts.sh` sets the domains). Not part of CI.
const PORT = process.env.QAMAR_PORT ?? '3100';
const HOST_BASE = process.env.QAMAR_HOST_BASE ?? 'localhost';
const BASE = process.env.QAMAR_BASE_URL ?? `http://localhost:${PORT}`;
const launchOptions = {
  ...(HOST_BASE !== 'localhost'
    ? { args: [`--host-resolver-rules=MAP *.${HOST_BASE} 127.0.0.1`] }
    : {}),
  ...(process.env.QAMAR_CHANNEL ? { channel: process.env.QAMAR_CHANNEL } : {}),
};

export default defineConfig({
  testDir: './tests/qamar',
  fullyParallel: true,
  retries: 0,
  workers: Number(process.env.QAMAR_WORKERS ?? 2),
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: BASE, navigationTimeout: 90_000, launchOptions },
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
