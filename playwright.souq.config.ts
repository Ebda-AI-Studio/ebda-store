import { defineConfig, devices } from '@playwright/test';

// Souq looks (Phase B2 Task 7): scenario matrix + demo-bar checks against a LOCAL stack.
// Needs the seeded stores: scripts/storedemo/seed.mjs --template souq --local-look-stores and
// scripts/storedemo/scenario-stores.mjs, and the host->store dev proxy on SOUQ_PORT
// (store hosts are <slug>.<SOUQ_HOST_BASE>:<port>, default localhost). Not part of CI.
const PORT = process.env.SOUQ_PORT ?? '3200';
const HOST_BASE = process.env.SOUQ_HOST_BASE ?? 'localhost';
const BASE = process.env.SOUQ_BASE_URL ?? `http://localhost:${PORT}`;
const hostMap =
  HOST_BASE !== 'localhost' ? { args: [`--host-resolver-rules=MAP *.${HOST_BASE} 127.0.0.1`] } : {};

export default defineConfig({
  testDir: './tests/souq',
  fullyParallel: true,
  retries: 0,
  workers: Number(process.env.SOUQ_WORKERS ?? 2),
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE,
    navigationTimeout: 90_000,
    launchOptions: hostMap,
    // SOUQ_CHANNEL=chrome drives an installed Chrome when no Playwright chromium is cached.
    ...(process.env.SOUQ_CHANNEL ? { channel: process.env.SOUQ_CHANNEL } : {}),
  },
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
