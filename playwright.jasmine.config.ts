import { defineConfig, devices } from '@playwright/test';

// Jasmine looks (Phase B3 Task 6): scenario matrix + demo-bar checks against a LOCAL stack.
// Needs the seeded stores: scripts/storedemo/seed.mjs --template jasmine --local-look-stores and
// scripts/storedemo/scenario-stores.mjs --template jasmine, and the stack on JASMINE_PORT. The
// store hosts are `<slug>.<JASMINE_HOST_BASE>:<port>`:
//   - a dev stack (`next dev`) serves `<slug>.localhost` natively (JASMINE_HOST_BASE=localhost);
//   - a PRODUCTION build refuses `.localhost` store hosts, so the stores carry a custom domain
//     `<slug>.localhost-b3.test` (stores.domain, local DB only; the name contains "localhost" so the
//     API's dev CORS rule admits the origin) and the browser maps `*.localhost-b3.test` to loopback
//     (JASMINE_HOST_BASE=localhost-b3.test adds `--host-resolver-rules=MAP *.localhost-b3.test 127.0.0.1`).
// Never reads a production URL. Not part of CI.
const PORT = process.env.JASMINE_PORT ?? '3300';
const HOST_BASE = process.env.JASMINE_HOST_BASE ?? 'localhost';
const BASE = process.env.JASMINE_BASE_URL ?? `http://localhost:${PORT}`;
const launchOptions = {
  ...(HOST_BASE !== 'localhost'
    ? { args: [`--host-resolver-rules=MAP *.${HOST_BASE} 127.0.0.1`] }
    : {}),
  // JASMINE_CHANNEL=chrome drives an installed Chrome when no Playwright chromium is cached.
  ...(process.env.JASMINE_CHANNEL ? { channel: process.env.JASMINE_CHANNEL } : {}),
};

export default defineConfig({
  testDir: './tests/jasmine',
  fullyParallel: true,
  retries: 0,
  workers: Number(process.env.JASMINE_WORKERS ?? 2),
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
