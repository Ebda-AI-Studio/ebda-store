import { defineConfig, devices } from '@playwright/test';

// Operator-run checks that need a human (an inbox, a phone). Never part of CI or any test glob:
// Ruling LIC-HYGIENE-1. Run a file explicitly: npx playwright test -c playwright.manual.config.ts
export default defineConfig({
  testDir: './scripts/manual',
  testMatch: /\.manual\.ts$/,
  workers: 1,
  timeout: 90_000,
  use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
});
