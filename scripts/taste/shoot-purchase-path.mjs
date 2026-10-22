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
import { probePage } from './purchase-path-probe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'docs/ebda/templates/purchase-path.json'), 'utf8')
);

/** The option-less second line of the `two-lines` cart action; `--second-product` overrides it. */
let SECOND_PRODUCT_PATH = MANIFEST.secondProductPath;

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
/** Every value of a repeatable flag (`--path pdp=/products/x --path category=/products?category=y`). */
const args = name =>
  process.argv.flatMap((a, i) =>
    a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []
  );

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
  // A fresh number per run: the API caps orders awaiting payment per phone, so a re-shoot
  // with one fixed number is refused ("too many orders awaiting payment").
  const phone = `010${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  await page.locator('input[autocomplete="tel"]').fill(phone);
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

const SHIPPING_CALC = '**/shipping/calculate';

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
    // Hydration first: a click before the store context resolves posts the cart with no store
    // header (STORE_NOT_RESOLVED), a harness race seen once on a freshly compiled dev server.
    await settle(page);
    await pickOptions(page);
    await page.getByTestId('pdp-add').first().click();
    await page.waitForTimeout(1200);
  },
  async 'two-lines'(page, url, base) {
    // A second, option-less line, so the cart shows two rows.
    await page.goto(`${base}${SECOND_PRODUCT_PATH}`, {
      waitUntil: 'networkidle',
      timeout: 180000,
    });
    await settle(page);
    await page.getByTestId('pdp-add').first().click();
    await page.waitForTimeout(1200);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
  },
  async 'increase-quantity'(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await page
      .getByRole('button', { name: /Increase quantity|زيادة الكمية|زيادة كمية/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
  },
  async 'remove-line-with-undo'(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await page
      .getByRole('button', { name: /^(Remove|إزالة) / })
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
  async 'fill-shipping'(page, url) {
    // The form after the shopper picked a governorate and an area: the combobox clear buttons
    // exist only now (STOP-2 P1-1: they measured 20x20 and no earlier screen showed them).
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await fillShipping(page);
    await page.waitForTimeout(1500);
  },
  async 'fill-shipping-calc-fails'(page, url) {
    // The "couldn't calculate shipping" panel with its Retry button (STOP-2 P1-1).
    await page.route(SHIPPING_CALC, route => route.fulfill({ status: 500, body: '{}' }));
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await fillShipping(page);
    await page.waitForTimeout(2500);
  },
  async 'fill-and-continue'(page, url) {
    await page.unroute(SHIPPING_CALC).catch(() => {});
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    await fillShipping(page);
    await continueToPayment(page);
    await page.waitForTimeout(2000);
  },
  async 'apply-bad-coupon'(page) {
    // Continues on the payment step: a code the store does not have.
    const field = page.getByRole('textbox', { name: /Coupon code|كود الخصم/ }).first();
    await field.fill('NOPE2026');
    await page
      .getByRole('button', { name: /^(Apply|تطبيق)$/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
  },
  async 'place-cod-order'(page) {
    // Continues from the payment step the previous screen left open.
    const cod = page.locator('input[type="radio"][value="cod"]');
    if (await cod.count()) await cod.check();
    // A store with delivery date chips (Phase B4, Ruling B4-7) needs a date and, with windows, a
    // bookable window: take the first date and the first enabled window, as a shopper would.
    const dates = page.getByRole('radiogroup', { name: /Delivery date|يوم التوصيل/ });
    if (await dates.count()) {
      await dates.getByRole('radio').first().click();
      const wins = page.getByRole('radiogroup', { name: /Delivery window|موعد التوصيل/ });
      if (await wins.count())
        await wins.getByRole('radio').and(page.locator(':enabled')).first().click();
      await page.waitForTimeout(300);
    }
    await page
      .getByRole('button', { name: /Place order|تأكيد الطلب/ })
      .first()
      .click();
    await page.waitForURL(/\/checkout\/success/, { timeout: 60000, waitUntil: 'commit' }); // client-side push: no load event
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
    console.error(
      'usage: --store <slug> --out <dir> [--base url] [--prefix name] [--screens a,b] [--viewports 390-ar,1280-en] [--template souq] [--path <screen>=<path>]... [--second-product <path>]'
    );
    process.exit(2);
  }
  // A store that is not the Qamar boutique names its own paths (Souq: phones / a phone / earbuds);
  // a subset of screens and viewports keeps a direction pack to the screens that decide it.
  const only = arg('screens')?.split(',');
  const onlyViewports = arg('viewports')?.split(',');
  // --template <name>: that template's path set from the manifest (explicit flags still win).
  const tpl = arg('template') ? MANIFEST.templates?.[arg('template')] : undefined;
  if (arg('template') && !tpl) throw new Error(`no template "${arg('template')}" in the manifest`);
  const pathOverride = {
    ...(tpl?.paths ?? {}),
    ...Object.fromEntries(args('path').map(p => p.split(/=(.*)/s).slice(0, 2))),
  };
  SECOND_PRODUCT_PATH =
    arg('second-product') ?? tpl?.secondProductPath ?? MANIFEST.secondProductPath;
  const screens = MANIFEST.screens
    .filter(s => !only || only.includes(s.id))
    .map(s => ({ ...s, path: pathOverride[s.id] ?? s.path }));
  const viewportIds = MANIFEST.viewports.filter(v => !onlyViewports || onlyViewports.includes(v));
  const u = new URL(base);
  const host = `${store}.${u.hostname}`;
  const origin = `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
  mkdirSync(out, { recursive: true });
  const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright');
  const consent = encodeURIComponent(JSON.stringify({ v: 1, marketing: false, analytics: false }));
  // SHOOT_CHANNEL=chrome drives an installed Chrome when no Playwright chromium is cached.
  // SHOOT_HOST_RULES (e.g. `MAP *.b3.test 127.0.0.1`) maps store hosts to the local stack when the
  // stack is a PRODUCTION build: it refuses the `<slug>.localhost` dev hosts, so the stores carry a
  // custom domain and the browser resolves it.
  const browser = await chromium.launch({
    ...(process.env.SHOOT_CHANNEL ? { channel: process.env.SHOOT_CHANNEL } : {}),
    ...(process.env.SHOOT_HOST_RULES
      ? { args: [`--host-resolver-rules=${process.env.SHOOT_HOST_RULES}`] }
      : {}),
  });
  const run = [];
  const probes = [];
  // Warm-up: compile each manifest route once before shooting, so a dev server's first-compile
  // hiccup (an error fallback, a missing store header) never lands in a measured screen.
  {
    const warm = await browser.newContext();
    const wp = await warm.newPage();
    for (const path of new Set(screens.map(s => s.path)))
      await wp
        .goto(`${origin}${path}`, { waitUntil: 'networkidle', timeout: 180000 })
        .catch(() => {});
    await warm.close();
  }
  for (const vid of viewportIds) {
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
    for (const s of screens) {
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
        // Rule (d) on the rendered page, plus contrast where the manifest asks for it (W5).
        const found = await probePage(page, { contrast: (s.probe ?? []).includes('contrast') });
        probes.push({ screen: s.id, viewport: vid, ...found });
        run.push({
          screen: s.id,
          viewport: vid,
          ok: true,
          url: page.url(),
          title: await page.title(),
        });
      } catch (e) {
        // Keep what the page showed when the step failed, so the failure can be read.
        await page.screenshot({ path: join(out, `${tag}-FAILED.png`) }).catch(() => {});
        run.push({ screen: s.id, viewport: vid, ok: false, error: String(e).slice(0, 300) });
      }
    }
    await ctx.close();
  }
  await browser.close();
  writeFileSync(join(out, `${prefix}-manifest-run.json`), JSON.stringify(run, null, 1));
  writeFileSync(join(out, `${prefix}-probe.json`), JSON.stringify(probes, null, 1));
  const failed = run.filter(r => !r.ok);
  console.log(`${prefix}: ${run.length - failed.length}/${run.length} shot`);
  for (const f of failed) console.log(`  FAILED ${f.screen} ${f.viewport}: ${f.error}`);
  const bad = probes.filter(p => p.targets.length || p.lowContrast.length);
  for (const p of bad) {
    for (const t of p.targets) console.log(`  TARGET<44 ${p.screen} ${p.viewport}: ${t}`);
    for (const c of p.lowContrast) console.log(`  CONTRAST ${p.screen} ${p.viewport}: ${c}`);
  }
  process.exit(failed.length || bad.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
