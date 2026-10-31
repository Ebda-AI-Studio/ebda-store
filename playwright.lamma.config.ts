import { defineConfig, devices } from '@playwright/test';

// Lamma looks (Phase B4 Task 7): scenario matrix + demo-bar checks against a LOCAL stack.
// One-shot local setup (seeds every showroom the demo bar switches to, sets the custom domains):
//   bash scripts/lamma-demo/seed-local-hosts.sh   (LOCAL DATABASE_URL only)
// Needs the seeded stores: scripts/storedemo/seed.mjs --template lamma --local-look-stores and
// scripts/storedemo/scenario-stores.mjs --template lamma, and the stack on LAMMA_PORT. The
// store hosts are `<slug>.<LAMMA_HOST_BASE>:<port>`:
//   - a dev stack (`next dev`) serves `<slug>.localhost` natively (LAMMA_HOST_BASE=localhost);
//   - a PRODUCTION build refuses `.localhost` store hosts, so the stores carry a custom domain
//     `<slug>.localhost-b4.test` (stores.domain, local DB only; the name contains "localhost" so the
//     API's dev CORS rule admits the origin) and the browser maps `*.localhost-b4.test` to loopback
//     (LAMMA_HOST_BASE=localhost-b4.test adds `--host-resolver-rules=MAP *.localhost-b4.test 127.0.0.1`).
// SAME-SITE API (needed by every test that signs a customer in, e.g. "order again"): the API sets its refresh
// cookie SameSite=Lax outside production, and a Lax cookie is not sent on a fetch from `<slug>.localhost-b4.test`
// to `localhost:4000` (cross-site), so the session restore got 401 on tablet and desktop. Build and start the web
// with NEXT_PUBLIC_API_URL=http://api.<LAMMA_HOST_BASE>:<api port>/api/v1 (the browser maps `*.<HOST_BASE>` to
// loopback; the Next server needs the same name mapped, e.g. `node --require` a dns.lookup patch), so web and API
// share one site. Proven 2026-10-31: the same test passes on tablet and desktop once the API host is same-site.
// Never reads a production URL. Not part of CI.
const PORT = process.env.LAMMA_PORT ?? '3400';
const HOST_BASE = process.env.LAMMA_HOST_BASE ?? 'localhost';
const BASE = process.env.LAMMA_BASE_URL ?? `http://localhost:${PORT}`;
const launchOptions = {
  ...(HOST_BASE !== 'localhost'
    ? { args: [`--host-resolver-rules=MAP *.${HOST_BASE} 127.0.0.1`] }
    : {}),
  // LAMMA_CHANNEL=chrome drives an installed Chrome when no Playwright chromium is cached.
  ...(process.env.LAMMA_CHANNEL ? { channel: process.env.LAMMA_CHANNEL } : {}),
};

export default defineConfig({
  testDir: './tests/lamma',
  fullyParallel: true,
  retries: 0,
  workers: Number(process.env.LAMMA_WORKERS ?? 2),
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
