/**
 * STORE-QA-119 prod guard: a signed-in shopper stays signed in on the account page, on a <slug>.ebda.app host AND
 * on a merchant custom domain. The shopper session must be a first-party cookie on the host being browsed.
 *
 * Needs a dedicated QA SHOPPER (verified email) on each store, created by hand once. Credentials come ONLY from the
 * environment (GitHub secrets PRELAUNCH_SHOPPER_EMAIL / PRELAUNCH_SHOPPER_PASSWORD); no secret = the test is skipped
 * and the workflow prints that it did not run. Hosts: PRELAUNCH_SESSION_HOSTS (space-separated origins, default the
 * slug host + the Amelia Aurum custom domain). Never places an order, never writes anything but the login itself.
 */
import { expect, test } from '@playwright/test';

const EMAIL = process.env.PRELAUNCH_SHOPPER_EMAIL;
const PASSWORD = process.env.PRELAUNCH_SHOPPER_PASSWORD;
const HOSTS = (
  process.env.PRELAUNCH_SESSION_HOSTS ?? 'https://ameliaaurum.ebda.app https://ameliaaurum.com'
)
  .split(/\s+/)
  .filter(Boolean);

test.skip(
  !EMAIL || !PASSWORD,
  'PRELAUNCH_SHOPPER_EMAIL / PRELAUNCH_SHOPPER_PASSWORD not set: session journey NOT run'
);

for (const origin of HOSTS) {
  for (const lang of ['ar', 'en'] as const) {
    test(`shopper stays signed in on ${origin} (${lang})`, async ({ page }) => {
      await page.context().addCookies([
        { name: 'force-language', value: lang, url: origin },
        {
          name: 'force-cookie-consent',
          value: encodeURIComponent(
            JSON.stringify({ marketing: false, v: 1, ts: '2026-11-10T00:00:00Z' })
          ),
          url: origin,
        },
      ]);
      await page.goto(`${origin}/${lang}/auth/login`, { waitUntil: 'domcontentloaded' });
      await page.locator('input[type="email"]').fill(EMAIL!);
      await page.locator('input[type="password"]').fill(PASSWORD!);
      await page.locator('form button[type="submit"]').first().click();
      await page.waitForLoadState('networkidle').catch(() => {});

      // The session cookies must be FIRST-PARTY on this host (host-only), never on the API host.
      const cookies = await page.context().cookies(origin);
      const session = cookies.find(c => c.name === 'refresh_token');
      expect(session, 'refresh_token cookie is set on the storefront host').toBeTruthy();
      expect(session!.domain.replace(/^\./, '')).toBe(new URL(origin).hostname);
      expect(session!.httpOnly).toBe(true);
      expect(session!.secure).toBe(true);

      // "Press the account icon", then reload: still signed in (no redirect to login).
      for (const step of ['open', 'reload'] as const) {
        if (step === 'open')
          await page.goto(`${origin}/${lang}/account`, { waitUntil: 'domcontentloaded' });
        else await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        expect(page.url(), `${step}: not bounced to login`).not.toMatch(/\/auth\/login/);
        const me = await page.evaluate(
          async () => (await fetch('/api/v1/auth/me', { credentials: 'include' })).status
        );
        expect(me, `${step}: /api/v1/auth/me`).toBe(200);
      }
    });
  }
}
