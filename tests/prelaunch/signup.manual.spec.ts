import { expect, test } from '@playwright/test';

// MANUAL (needs an inbox): signs a new merchant up at store.ebda.app/signup and stops at
// "check your email". The verification code is read from the inbox by the operator.
// Run: PRELAUNCH_SIGNUP_EMAIL=... PRELAUNCH_SIGNUP_PHONE=... PRELAUNCH_SIGNUP_PASSWORD=... \
//      npx playwright test -c playwright.prelaunch.config.ts signup.manual --project=desktop
const email = process.env.PRELAUNCH_SIGNUP_EMAIL;
const phone = process.env.PRELAUNCH_SIGNUP_PHONE;
const password = process.env.PRELAUNCH_SIGNUP_PASSWORD;
const ADMIN = process.env.PRELAUNCH_ADMIN_URL ?? 'https://store.ebda.app';

test.skip(!email || !phone || !password, 'manual: set PRELAUNCH_SIGNUP_EMAIL/PHONE/PASSWORD');

test('merchant sign-up reaches "check your email"', async ({ page }) => {
  await page.goto(`${ADMIN}/signup`);
  // The form token must be fetched before submit (min fill time): wait for the network to settle.
  await page.waitForLoadState('networkidle');
  await page.locator('#signup-name').fill('QA Launch');
  await page.locator('#signup-email').fill(email!);
  await page.locator('#signup-phone').fill(phone!);
  await page.locator('#signup-password').fill(password!);
  await page.locator('#signup-legal').check();
  await page.waitForTimeout(3500); // > SIGNUP_MIN_FILL_MS (3000)
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText(email!)).toBeVisible();
});
