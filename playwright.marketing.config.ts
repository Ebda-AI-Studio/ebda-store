import { defineConfig } from '@playwright/test';

// Marketing layout checks (heading/next-sibling overlap) against a local static build of apps/marketing:
//   npm run build -w @ebda/marketing && npx playwright test -c playwright.marketing.config.ts
// Uses installed Chrome (channel: 'chrome') so it needs no `playwright install`.
const PORT = Number(process.env.MARKETING_PORT ?? 3917);
export default defineConfig({
  testDir: './tests/marketing-layout',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: process.env.MARKETING_BASE_URL ?? `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    reducedMotion: 'reduce',
  },
  webServer: process.env.MARKETING_BASE_URL
    ? undefined
    : {
        command: `node packages/site-kit/src/gates/serve-static.mjs apps/marketing/out ${PORT}`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: !process.env.CI, // never measure a stale server on CI; locally a dedicated port (3917, not the dev port 3005) keeps it honest
        timeout: 30_000,
      },
});
