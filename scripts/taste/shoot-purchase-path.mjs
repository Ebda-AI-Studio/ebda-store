#!/usr/bin/env node
// Quality bar § 10 rule (a): shoot every screen of the purchase-path manifest
// (docs/ebda/templates/purchase-path.json) at every viewport, for one store, before a look
// is scored. LOCAL stacks only: it adds to a cart and places a cash-on-delivery order.
//
//   node scripts/taste/shoot-purchase-path.mjs --store qamar-atelier --base http://localhost:3412 \
//     --out <dir> [--prefix atelier]
//
// Writes <out>/<prefix>-<screen>-<viewport>.png (the fold) and <...>-full.png (the page) for
// every screen x viewport, and <out>/<prefix>-manifest-run.json listing what it shot. A screen
// that could not be reached is written to the run file as failed (never silently skipped).
// tests/unit/purchase-path-gates.test.ts checks that every manifest action is implemented here.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'docs/ebda/templates/purchase-path.json'), 'utf8')
);

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

/** Viewport id ("390-ar") to a browser context shape. */
export function viewportOf(id) {
  const m = /^(\d+)-(ar|en)$/.exec(id);
  if (!m) throw new Error(`bad viewport id ${id}`);
  const w = Number(m[1]);
  return { id, w, h: w <= 390 ? 844 : w <= 820 ? 1180 : 800, lang: m[2], mobile: w < 1024 };
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => {});
  await page.waitForTimeout(500);
}

async function pickOptions(page) {
  for (const g of await page.$$('[data-option-group]')) {
    const b = await g.$('button[aria-pressed="false"]:not([disabled])');
    if (b) await b.click().catch(() => {});
  }
}

async function fillShipping(page) {
  await page.locator('input[autocomplete="given-name"]').fill('Mona');
  await page.locator('input[autocomplete="family-name"]').fill('Adel');
  await page.locator('input[autocomplete="tel"]').fill('01012345678');
  const combos = page.locator('input[role="combobox"]');
  for (let i = 0; i < (await combos.count()); i++) {
    await combos.nth(i).click();
    await page.waitForTimeout(500);
    const opt = page.getByRole('option').first();
    if (await opt.count()) await opt.click();
  }
  await page.locator('input[autocomplete="address-line1"]').fill('Abbas El Akkad');
  const building = page.getByLabel(/Building no\.|رقم المبنى/);
  if (await building.count()) await building.first().fill('12');
}

const continueToPayment = page =>
  page
    .getByRole('button', { name: /Continue to payment|المتابعة للدفع/ })
    .first()
    .click();

/**
 * Every manifest action. Each leaves the page on the screen to shoot. The flow is stateful
 * (one context per viewport), so screens run in manifest order.
 */
export const ACTIONS = {
  async none(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
  },
  async 'tap-add-without-options'(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await page.getByTestId('pdp-add').first().click();
    await page.waitForTimeout(800);
  },
  async 'pick-options-and-add'(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await pickOptions(page);
    await page.getByTestId('pdp-add').first().click();
    await page.waitForTimeout(1200);
  },
  async 'two-lines'(page, url, base) {
    // A second, option-less line, so the cart shows two rows.
    await page.goto(`${base}${MANIFEST.secondProductPath}`, {
      waitUntil: 'networkidle',
      timeout: 180000,
    });
    await page.getByTestId('pdp-add').first().click();
    await page.waitForTimeout(1200);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
  },
  async 'increase-quantity'(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await page
      .getByRole('button', { name: /Increase quantity|زيادة الكمية/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
  },
  async 'remove-line-with-undo'(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await page
      .getByRole('button', { name: /Remove item|إزالة المنتج/ })
      .last()
      .click();
    await page.waitForTimeout(700);
  },
  async empty(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
  },
  async 'submit-empty'(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await continueToPayment(page);
    await page.waitForTimeout(800);
  },
  async 'fill-and-continue'(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await fillShipping(page);
    await continueToPayment(page);
    await page.waitForTimeout(2000);
  },
  async 'place-cod-order'(page) {
    // Continues from the payment step the previous screen left open.
    const cod = page.locator('input[type="radio"][value="cod"]');
    if (await cod.count()) await cod.check();
    await page
      .getByRole('button', { name: /Place order|تأكيد الطلب/ })
      .first()
      .click();
    await page.waitForURL(/\/checkout\/success/, { timeout: 60000 });
    await page.waitForTimeout(3500); // the receipt's print-in feed
  },
  async 'scroll-to-footer'(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await settle(page);
    await page.locator('footer').last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
  },
};

async function main() {
  const store = arg('store');
  const base = (arg('base') ?? 'http://localhost:3412').replace(/\/$/, '');
  const out = arg('out');
  const prefix = arg('prefix') ?? store;
  if (!store || !out) {
    console.error('usage: --store <slug> --out <dir> [--base url] [--prefix name]');
    process.exit(2);
  }
  const u = new URL(base);
  const host = `${store}.${u.hostname}`;
  const origin = `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
  mkdirSync(out, { recursive: true });
  const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright');
  const consent = encodeURIComponent(JSON.stringify({ v: 1, marketing: false, analytics: false }));
  const browser = await chromium.launch();
  const run = [];
  for (const vid of MANIFEST.viewports) {
    const vp = viewportOf(vid);
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      deviceScaleFactor: 1,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      reducedMotion: 'reduce',
    });
    await ctx.addCookies([
      { name: 'force-language', value: vp.lang, domain: host, path: '/' },
      { name: 'force-cookie-consent', value: consent, domain: host, path: '/' },
    ]);
    const page = await ctx.newPage();
    for (const s of MANIFEST.screens) {
      const tag = `${prefix}-${s.id}-${vid}`;
      try {
        await ACTIONS[s.action ?? 'none'](page, `${origin}${s.path}`, origin);
        if (
          ![
            'scroll-to-footer',
            'remove-line-with-undo',
            'pick-options-and-add',
            'tap-add-without-options',
          ].includes(s.action ?? 'none')
        )
          await settle(page);
        await page.screenshot({ path: join(out, `${tag}.png`) });
        await page.screenshot({ path: join(out, `${tag}-full.png`), fullPage: true });
        run.push({
          screen: s.id,
          viewport: vid,
          ok: true,
          url: page.url(),
          title: await page.title(),
        });
      } catch (e) {
        run.push({ screen: s.id, viewport: vid, ok: false, error: String(e).slice(0, 300) });
      }
    }
    await ctx.close();
  }
  await browser.close();
  writeFileSync(join(out, `${prefix}-manifest-run.json`), JSON.stringify(run, null, 1));
  const failed = run.filter(r => !r.ok);
  console.log(`${prefix}: ${run.length - failed.length}/${run.length} shot`);
  for (const f of failed) console.log(`  FAILED ${f.screen} ${f.viewport}: ${f.error}`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
