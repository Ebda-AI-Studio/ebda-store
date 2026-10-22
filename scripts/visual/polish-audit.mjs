// Launch polish audit (docs/plans/2026-10-23-launch-polish.md): drives a LIVE demo store through
// every look x {ar,en} x {390,1280} x {home, PLP, PDP, cart, checkout}; records axe (wcag2a/aa/21aa),
// horizontal overflow and small hit boxes, and writes PNGs + report.json. Read-only against production
// (the cart add is a guest write; the demo refuses orders). Run from the repo root:
//   node scripts/visual/polish-audit.mjs storedemo qamar qamar.atelier,qamar.lookbook,qamar.vitrine
// Caveats: `small` measures the element box, so a control with a ::before hit-box extension
// (cards' heart) over-reports; the PDP step needs a PDP link on the PLP and can time out on a cold start.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const W = process.cwd();
const req = createRequire(W + '/package.json');
const { chromium } = req('playwright');
const AXE = fs.readFileSync(W + '/node_modules/axe-core/axe.min.js', 'utf8');
const [store, tpl, looksCsv, outName] = process.argv.slice(2);
const looks = looksCsv.split(',');
const OUT = `${process.env.TMPDIR || '/tmp'}/polish-audit/${outName || tpl}`;
fs.mkdirSync(OUT, { recursive: true });
const origin = `https://${store}.ebda.app`;
const b = await chromium.launch();
const res = [];
const consent = encodeURIComponent(
  JSON.stringify({ marketing: false, v: 1, ts: '2026-10-07T00:00:00Z' })
);
async function metrics(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const vis = e => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== 'hidden' &&
        s.display !== 'none' &&
        s.opacity !== '0'
      );
    };
    const small = [
      ...document.querySelectorAll(
        'a[href],button,input:not([type=hidden]),select,textarea,[role=button]'
      ),
    ]
      .filter(
        e =>
          vis(e) &&
          !e.closest('[aria-hidden=true]') &&
          !(
            e.tagName === 'A' &&
            e.textContent.trim().length > 0 &&
            getComputedStyle(e).display === 'inline'
          )
      )
      .map(e => ({ r: e.getBoundingClientRect(), e }))
      .filter(x => x.r.height < 44 || x.r.width < 44)
      .filter(
        x =>
          (x.r.height < 44 && x.r.width < 44) || x.e.tagName === 'BUTTON' || x.e.tagName === 'INPUT'
      )
      .map(
        x =>
          x.e.tagName +
          (x.e.getAttribute('aria-label')
            ? '[' + x.e.getAttribute('aria-label').slice(0, 20) + ']'
            : '') +
          ':' +
          Math.round(x.r.width) +
          'x' +
          Math.round(x.r.height)
      );
    const over = [...document.querySelectorAll('body *')]
      .filter(e => {
        const r = e.getBoundingClientRect();
        return (
          r.width > 0 &&
          (r.right > vw + 1 || r.left < -1) &&
          vis(e) &&
          !e.closest('[class*=overflow-x],[style*=overflow]') &&
          getComputedStyle(e).position !== 'fixed'
        );
      })
      .slice(0, 5)
      .map(e => e.tagName + '.' + (e.className + '').slice(0, 40));
    return {
      docW: document.documentElement.scrollWidth,
      vw,
      small: [...new Set(small)].slice(0, 12),
      nSmall: small.length,
      over,
    };
  });
}
for (const look of looks)
  for (const lang of ['ar', 'en'])
    for (const w of [390, 1280]) {
      const ctx = await b.newContext({
        viewport: { width: w, height: w < 500 ? 844 : 800 },
        locale: lang === 'ar' ? 'ar-EG' : 'en-US',
        deviceScaleFactor: 1,
      });
      await ctx.addCookies([
        { name: 'force-language', value: lang, url: origin },
        { name: 'force-cookie-consent', value: consent, url: origin },
      ]);
      const page = await ctx.newPage();
      const errs = [];
      page.on('console', m => {
        if (m.type() === 'error') errs.push(m.text().slice(0, 120));
      });
      const tag = `${look.split('.')[1]}-${lang}-${w}`;
      const row = { look, lang, w, pages: {} };
      let pdp = null;
      for (const [name, p] of [
        ['home', '/'],
        ['plp', '/products'],
        ['pdp', null],
        ['cart', '/cart'],
        ['checkout', '/checkout'],
      ]) {
        try {
          let url = p;
          if (name === 'pdp') {
            if (!pdp) {
              row.pages.pdp = { err: 'no pdp link' };
              continue;
            }
            url = pdp;
          }
          await page.goto(`${origin}${url}${url.includes('?') ? '&' : '?'}look=${look}`, {
            waitUntil: 'load',
            timeout: 120000,
          });
          await page.waitForTimeout(2800);
          if (name === 'plp')
            pdp = await page.evaluate(() => {
              const a = [...document.querySelectorAll('a[href*="/products/"]')]
                .map(a => a.getAttribute('href'))
                .find(h => h && !h.endsWith('/products/'));
              return a ? a.split('?')[0] : null;
            });
          if (name === 'pdp') {
            const btn = page.locator('button:has-text("أضف"), button:has-text("Add to")').first();
            if (await btn.count()) {
              await btn.click({ timeout: 4000 }).catch(() => {});
              await page.waitForTimeout(800);
            }
          }
          const m = await metrics(page);
          await page.addScriptTag({ content: AXE });
          const ax = await page.evaluate(async () =>
            (
              await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })
            ).violations.map(v => v.id + '(' + v.impact + ',' + v.nodes.length + ')')
          );
          m.axe = ax;
          row.pages[name] = m;
          await page.screenshot({ path: `${OUT}/${tag}-${name}.png`, fullPage: false });
        } catch (e) {
          row.pages[name] = { err: String(e).slice(0, 100) };
        }
      }
      row.consoleErrors = [...new Set(errs)].slice(0, 4);
      res.push(row);
      await ctx.close();
    }
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(res, null, 1));
// summary
for (const r of res) {
  const bad = Object.entries(r.pages).map(([k, v]) =>
    v.err
      ? `${k}:ERR`
      : `${k}:${v.docW > v.vw ? 'HSCROLL ' : ''}small=${v.nSmall} axe=${v.axe.join('|')}`
  );
  console.log(r.look, r.lang, r.w, '\n  ', bad.join('\n   '));
}
await b.close();
