#!/usr/bin/env node
/**
 * Loads storefront pages in headless Chromium against a LOCAL `next start` of apps/web and fails on any CSP
 * violation (Ruling CSP-WEB-1). Public GET reads only; nothing is added to a cart or submitted.
 *
 *   cd apps/web && NEXT_PUBLIC_API_URL=https://api.ebda.app/api/v1 npx next build && npx next start -p 3919 &
 *   node scripts/qa/storefront-csp-check.mjs [--port 3919] [--stores storedemo,storedemo-dahab,...]
 *
 * Each store host is mapped to the local server by Chromium's host resolver, so the Host header is the real
 * `<slug>.ebda.app` while api.ebda.app stays the real API. Every page is loaded in Arabic and English (the
 * `force-language` cookie). Reports: CSP console errors, `securitypolicyviolation` events, and executable
 * inline scripts that carry no nonce.
 */
import { chromium } from 'playwright';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg('port', '3919'));
const STORES = arg(
  'stores',
  'storedemo,storedemo-dahab,storedemo-jasmine,storedemo-lamma,storedemo-souq'
).split(',');
const PATHS = [
  '/',
  '/products',
  '/categories',
  '/search?q=a',
  '/cart',
  '/checkout',
  '/compare',
  '/wishlist',
  '/about',
  '/contact',
  '/faq',
  '/privacy',
  '/terms',
  '/returns',
  '/shipping',
  '/size-guide',
  '/locations',
  '/bundles',
  '/how-to-guides',
  '/blog',
  '/this-page-does-not-exist',
];

// One --host-resolver-rules flag takes ONE comma-separated rule list.
const rules = STORES.map(s => `MAP ${s}.ebda.app 127.0.0.1:${PORT}`).join(',');
const b = await chromium.launch({ args: [`--host-resolver-rules=${rules}`] });

let pages = 0;
const problems = [];
for (const store of STORES) {
  for (const lang of ['ar', 'en']) {
    const ctx = await b.newContext();
    await ctx.addCookies([
      { name: 'force-language', value: lang, url: `http://${store}.ebda.app` },
    ]);
    await ctx.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', e =>
        window.__cspViolations.push(
          `${e.violatedDirective} ${e.blockedURI} ${e.sample ?? ''}`.trim()
        )
      );
    });
    const page = await ctx.newPage();
    const consoleCsp = [];
    page.on('console', m => {
      if (/content security policy|refused to (execute|load|connect|apply)/i.test(m.text()))
        consoleCsp.push(m.text().slice(0, 300));
    });
    const hrefs = new Set();
    for (const p of PATHS) {
      const url = `http://${store}.ebda.app${p}`;
      consoleCsp.length = 0;
      let status = 0;
      try {
        const res = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
        status = res?.status() ?? 0;
        if (p === '/products') {
          for (const h of await page.$$eval('a[href^="/products/"]', as =>
            as.map(a => a.getAttribute('href'))
          ))
            hrefs.add(h);
        }
      } catch (e) {
        problems.push(`${store} ${lang} ${p}: navigation failed: ${e.message.split('\n')[0]}`);
        continue;
      }
      pages++;
      await page.waitForTimeout(1500);
      const info = await page.evaluate(() => ({
        v: window.__cspViolations,
        bare: [...document.scripts]
          .filter(s => !s.src && s.type !== 'application/ld+json' && s.type !== 'application/json')
          .filter(s => !s.nonce)
          .map(s => s.textContent.slice(0, 80)),
      }));
      const tag = `${store} ${lang} ${p} (${status})`;
      for (const v of info.v) problems.push(`${tag}: violation ${v}`);
      for (const c of consoleCsp) problems.push(`${tag}: console ${c}`);
      for (const s of info.bare) problems.push(`${tag}: inline script without nonce: ${s}`);
    }
    // one product page per store/lang
    const first = [...hrefs][0];
    if (first) {
      consoleCsp.length = 0;
      try {
        await page.goto(`http://${store}.ebda.app${first}`, { waitUntil: 'load', timeout: 45000 });
        await page.waitForTimeout(1500);
        pages++;
        const v = await page.evaluate(() => window.__cspViolations);
        for (const x of v) problems.push(`${store} ${lang} ${first}: violation ${x}`);
        for (const c of consoleCsp) problems.push(`${store} ${lang} ${first}: console ${c}`);
      } catch (e) {
        problems.push(`${store} ${lang} ${first}: navigation failed: ${e.message.split('\n')[0]}`);
      }
    }
    await ctx.close();
  }
}
await b.close();
console.log(`pages loaded: ${pages}, problems: ${problems.length}`);
for (const p of problems) console.log(' - ' + p);
process.exit(problems.length ? 1 : 0);
