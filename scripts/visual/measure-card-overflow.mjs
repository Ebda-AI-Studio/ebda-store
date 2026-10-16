#!/usr/bin/env node
// Layout proof for FU46 / D7: a long product name and the add-to-cart CTA must stay
// inside their card on every skin. jsdom has no layout, so this drives real Chromium.
//
//   npm run test:card-overflow -- [--widths 390,360,320] [--skins modern,dahab] [--pages plp,pdp] [--label after] [--out <dir>]
//
// Needs the local stack + the seed (scripts/visual/seed-card-overflow.mjs):
//   1. DATABASE_URL=<owner url on localhost> node scripts/visual/seed-card-overflow.mjs
//   2. API (`npm run dev:api`), web (`npx next dev -p 3151` in apps/web) and a host->store proxy
//      that stamps x-store-domain = <slug>.ebda.app from <slug>.localhost
//      (see .superpowers/shared/local-stack/README.md, dev-proxy.mjs) on WEB_PORT (default 3150).
// Exits 1 when any card name/CTA overflows its box (> TOL px for names: trailing letter-spacing
// is counted by scrollWidth but is not visible), or the page scrolls sideways. Items clipped by a
// horizontal carousel scroller are intended (cards peek) and are NOT counted.
// Writes <out>/<label>-<skin>-<page>-<lang>-<width>.png and <out>/report-<label>.json.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, '../../package.json'))('playwright');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const WIDTHS = arg('widths', '390,360,320').split(',').map(Number);
const SKINS = arg('skins', 'modern,elegant,classic,minimal,bold,dahab').split(',');
const LABEL = arg('label', 'run');
const OUT = resolve(arg('out', join(tmpdir(), 'card-overflow')));
const PORT = process.env.WEB_PORT || '3150';
const TOL = 8; // px of trailing letter-spacing a name may "overflow" by without being visible
const ALL_PAGES = {
  plp: '/products',
  home: '/',
  pdp: '/products/linen-abaya',
  pdpLongAr: '/products/long-ar',
  pdpLongEn: '/products/long-en',
};
const PAGES = Object.fromEntries(
  Object.entries(ALL_PAGES).filter(([k]) =>
    arg('pages', Object.keys(ALL_PAGES).join(',')).split(',').includes(k)
  )
);
const NAMES = ['عباية كتان مطرزة', 'Handembroidered'];
const CTA = ['add to cart', 'أضف للسلة', 'add to bag', 'select options'];

const probe = ({ NAMES, CTA }) => {
  const items = [];
  const inScroller = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (
        (cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
        p.scrollWidth > p.clientWidth + 1
      )
        return true;
    }
    return false;
  };
  const visible = el =>
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  for (const el of document.querySelectorAll('h1,h2,h3,h4,a,button,p,span,div')) {
    if (el.children.length > (el.tagName === 'DIV' ? 0 : 2) || !visible(el)) continue;
    const label = el.getAttribute('aria-label') ?? '';
    const t = (el.textContent || '').trim();
    const compact = el.getAttribute('data-cta') === 'add-compact';
    const cs = getComputedStyle(el);
    // a one-line `truncate` (sticky buy bar) ellipsizes ON PURPOSE; a clamp/wrap box must not overflow
    const truncates = cs.whiteSpace === 'nowrap' && cs.textOverflow === 'ellipsis';
    const isName = t.length > 20 && NAMES.some(n => t.startsWith(n)) && !truncates;
    const isCta = CTA.includes(t.toLowerCase());
    if (!isName && !isCta && !compact) continue;
    const r = el.getBoundingClientRect();
    items.push({
      kind: compact ? 'cta-compact' : isName ? 'name' : 'cta',
      text: (t || label).slice(0, 24),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      w: Math.round(r.width),
      overflow: el.scrollWidth - el.clientWidth,
      scroller: inScroller(el),
      offViewport: r.left < -1 || r.right > innerWidth + 1,
    });
  }
  return { docOver: document.documentElement.scrollWidth > innerWidth + 1, items };
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const report = {};
let failures = 0;
try {
  for (const width of WIDTHS) {
    for (const skin of SKINS) {
      const host = `fu-${skin}.localhost`;
      for (const lang of ['ar', 'en']) {
        const ctx = await browser.newContext({
          viewport: { width, height: 844 },
          deviceScaleFactor: 1,
          isMobile: true,
          hasTouch: true,
        });
        await ctx.addCookies([
          { name: 'force-language', value: lang, domain: host, path: '/' },
          {
            name: 'force-cookie-consent',
            value: encodeURIComponent(JSON.stringify({ v: 1, marketing: false, analytics: false })),
            domain: host,
            path: '/',
          },
        ]);
        const page = await ctx.newPage();
        for (const [pn, path] of Object.entries(PAGES)) {
          const key = `${width}/${skin}/${lang}/${pn}`;
          try {
            const resp = await page.goto(`http://${host}:${PORT}${path}`, {
              waitUntil: 'networkidle',
              timeout: 90000,
            });
            await page.waitForTimeout(500);
            await page.evaluate(async () => {
              for (let y = 0; y < document.body.scrollHeight; y += 500) {
                window.scrollTo(0, y);
                await new Promise(s => setTimeout(s, 80));
              }
            });
            await page.waitForTimeout(400); // let the compact-CTA ResizeObserver settle
            await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
            const res = await page.evaluate(probe, { NAMES, CTA });
            const bad = res.items.filter(
              i =>
                !i.scroller &&
                (i.kind === 'name' ? i.overflow > TOL : i.kind === 'cta' ? i.overflow > 0 : false)
            );
            report[key] = {
              status: resp?.status(),
              docOver: res.docOver,
              bad,
              compact: res.items.filter(i => i.kind === 'cta-compact').length,
              items: res.items.length,
            };
            if (resp?.status() !== 200 || res.docOver || bad.length) failures++;
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({
              path: join(OUT, `${LABEL}-${skin}-${pn}-${lang}-${width}.png`),
              fullPage: true,
            });
          } catch (e) {
            report[key] = { error: String(e).slice(0, 200) };
            failures++;
          }
        }
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}
writeFileSync(join(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 1));
for (const [k, v] of Object.entries(report)) {
  const flag = v.error || v.status !== 200 || v.docOver || v.bad?.length ? 'FAIL' : 'ok  ';
  console.log(
    flag,
    k.padEnd(26),
    v.error ??
      `status=${v.status} docOver=${v.docOver} items=${v.items} compactCtas=${v.compact} bad=${v.bad.length}`,
    (v.bad ?? []).map(b => `${b.kind}:${b.text}|${b.scrollW}>${b.clientW}`).join(' ; ')
  );
}
console.log(`\n${failures} failing page(s); screenshots + report in ${OUT}`);
process.exit(failures ? 1 : 0);
