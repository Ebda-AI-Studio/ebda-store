import { defineConfig, devices } from '@playwright/test';

/**
 * Visual builder, REAL stack end to end (no stand-ins): the real admin editor, the real storefront
 * in the canvas iframe, and the real API running in workerd (`wrangler dev`, the runtime the
 * preview and production APIs run on) as the strict-RLS role `ebda_app`, over a fresh local
 * Postgres seeded with the Dahab demo store. `playwright.builder.config.ts` is the fast contract
 * suite (in-memory API + fake canvas); this one proves the integration that suite cannot.
 *
 *   EDITOR_E2E_PG=postgresql://<superuser>:<pw>@<local-host>:5432/postgres \
 *     npx playwright test -c playwright.editor-live.config.ts
 *
 * The canvas is served at the store's real origin (`https://dahab-preview.ebda.app`): the test
 * routes that origin to the local storefront, so the exact origin strings the postMessage gate and
 * CSP compare are the production-shaped ones. Not in CI: it needs a local Postgres.
 */
const API_PORT = Number(process.env.EDITOR_E2E_API_PORT || 4931);
const WEB_PORT = Number(process.env.EDITOR_E2E_WEB_PORT || 3131);
const ADMIN_PORT = Number(process.env.EDITOR_E2E_ADMIN_PORT || 3132);
const DB = process.env.EDITOR_E2E_DB || 'ebda_editor_e2e';
const APP_PW = process.env.EDITOR_E2E_APP_PW || 'editor-e2e-app-pw';
const pg = new URL(process.env.EDITOR_E2E_PG || 'postgresql://localhost:5432/postgres');
const appUrl = `postgresql://ebda_app:${APP_PW}@${pg.hostname}:${pg.port || 5432}/${DB}`;
const ADMIN = `http://localhost:${ADMIN_PORT}`;
const API = `http://localhost:${API_PORT}`;

const apiVars = {
  NODE_ENV: 'development',
  JWT_SECRET: 'editor-e2e-jwt-secret-local-only-0123456789',
  ENCRYPTION_KEY: 'editor-e2e-encryption-key-local-only-0123456789',
  PAYMENT_PROVIDER_STUB: '1',
  WEB_URL: ADMIN,
  ADMIN_URL: ADMIN,
  API_URL: API,
};

export default defineConfig({
  testDir: './tests/editor-live-e2e',
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: ADMIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // The canvas (a public https origin) calls the local API from the browser; Chrome's
      // local-network-access gate would block that locally only (the hosted API is public).
      args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'],
    },
  },
  metadata: { webPort: WEB_PORT, apiUrl: API },
  projects: [
    {
      name: 'ar-1280',
      use: {
        ...devices['Desktop Chrome'],
        // real Google Chrome, the browser merchants use (EDITOR_E2E_CHANNEL= to use bundled Chromium)
        channel: process.env.EDITOR_E2E_CHANNEL ?? 'chrome',
        viewport: { width: 1280, height: 860 },
        locale: 'ar-EG',
      },
    },
  ],
  webServer: [
    {
      command:
        `node tests/editor-live-e2e/prepare-db.mjs && cd apps/api && npx wrangler dev --local ` +
        `--port ${API_PORT} --inspector-port ${API_PORT + 1} --persist-to "$(mktemp -d)" ` +
        Object.entries(apiVars)
          .map(([k, v]) => `--var ${k}:${v}`)
          .join(' '),
      url: `${API}/health`,
      timeout: 600_000,
      reuseExistingServer: !process.env.CI,
      env: { WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: appUrl },
    },
    {
      command: `npx next build && npx next start -p ${WEB_PORT}`,
      cwd: 'apps/web',
      port: WEB_PORT,
      timeout: 900_000,
      reuseExistingServer: !process.env.CI,
      env: {
        NEXT_PUBLIC_API_URL: `${API}/api/v1`,
        // the storefront may be framed by, and only talks to, this admin origin
        STOREFRONT_FRAME_ANCESTORS: ADMIN,
      },
    },
    {
      command: `npx next build && npx next start -p ${ADMIN_PORT}`,
      cwd: 'apps/admin',
      url: `${ADMIN}/login`,
      timeout: 900_000,
      reuseExistingServer: !process.env.CI,
      env: { NEXT_PUBLIC_API_URL: API },
    },
  ],
});
