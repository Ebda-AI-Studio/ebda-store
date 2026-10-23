// Measures prefers-reduced-motion on LIVE demo stores: with reduce emulated, nothing may move.
//   node scripts/visual/reduced-motion-check.mjs            (all five templates x 3 looks)
// Per look x {home, PLP, PDP} at 390 it reports: html scroll-behavior, elements whose computed
// transition/animation duration > 10ms (an element with only `transition: none` is fine), running
// animations > 10ms (document.getAnimations), playing <video>, and carousels that scroll/advance
// by themselves within 3 s. Exit 1 if anything is found. Read-only against production.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.cwd() + '/package.json')('playwright');
const SETS = [
  ['storedemo', '/products/linen-abaya', ['qamar.atelier', 'qamar.lookbook', 'qamar.vitrine']],
  [
    'storedemo-souq',
    '/products/power-bank-20000',
    ['souq.catalogue', 'souq.night', 'souq.showroom'],
  ],
  [
    'storedemo-jasmine',
    '/products/makeup-brush-set',
    ['jasmine.apothecary', 'jasmine.bloom', 'jasmine.clinic'],
  ],
  ['storedemo-lamma', '/products/black-tea', ['lamma.table', 'lamma.notebook', 'lamma.market']],
  [
    'storedemo-dahab',
    '/products/silver-band-ring',
    ['dahab.worn', 'dahab.workshop', 'dahab.giftbox'],
  ],
];
const only = process.argv[2]; // host substring, e.g. 'souq'. NC=1: negative control, no-preference must MOVE
const b = await chromium.launch();
let bad = 0;
for (const [host, pdp, looks] of SETS) {
  if (only && !host.includes(only)) continue;
  const origin = `https://${host}.ebda.app`;
  for (const look of looks) {
    const ctx = await b.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: process.env.NC ? 'no-preference' : 'reduce',
    });
    await ctx.addCookies([
      { name: 'force-language', value: 'ar', url: origin },
      {
        name: 'force-cookie-consent',
        value: encodeURIComponent(
          JSON.stringify({ marketing: false, v: 1, ts: '2026-10-07T00:00:00Z' })
        ),
        url: origin,
      },
    ]);
    const page = await ctx.newPage();
    for (const [name, path] of [
      ['home', '/'],
      ['plp', '/products'],
      ['pdp', pdp],
    ]) {
      await page.goto(`${origin}${path}?look=${look}`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForTimeout(3500);
      const r = await page.evaluate(async () => {
        const ms = v =>
          Math.max(
            0,
            ...String(v)
              .split(',')
              .map(x => (x.includes('ms') ? parseFloat(x) : parseFloat(x) * 1000) || 0)
          );
        const long = [];
        for (const e of document.querySelectorAll('*')) {
          const c = getComputedStyle(e);
          const t = c.transitionProperty === 'none' ? 0 : ms(c.transitionDuration);
          const a = c.animationName === 'none' ? 0 : ms(c.animationDuration);
          if (t > 10 || a > 10)
            long.push(`${e.tagName}.${String(e.className).slice(0, 40)} t=${t} a=${a}`);
        }
        const running = document
          .getAnimations()
          .filter(x => x.playState === 'running' && (x.effect?.getTiming().duration ?? 0) > 10)
          .map(
            x =>
              (x.animationName || x.transitionProperty || 'anim') +
              ':' +
              x.effect.getTiming().duration
          );
        const videos = [...document.querySelectorAll('video')].filter(v => !v.paused).length;
        const sc = [...document.querySelectorAll('*')].filter(
          e =>
            e.scrollWidth > e.clientWidth + 20 && /auto|scroll/.test(getComputedStyle(e).overflowX)
        );
        const before = sc.map(e => e.scrollLeft);
        await new Promise(r => setTimeout(r, 3000));
        const moved = sc
          .filter((e, i) => e.scrollLeft !== before[i])
          .map(e => String(e.className).slice(0, 40));
        return {
          smooth: getComputedStyle(document.documentElement).scrollBehavior,
          long: [...new Set(long)].slice(0, 6),
          nLong: long.length,
          running: [...new Set(running)].slice(0, 6),
          videos,
          moved,
        };
      });
      const flag = r.smooth !== 'auto' || r.nLong || r.running.length || r.videos || r.moved.length;
      if (flag) bad++;
      console.log(flag ? 'MOVES' : 'ok   ', look, name, flag ? JSON.stringify(r) : '');
    }
    await ctx.close();
  }
}
await b.close();
console.log(bad ? `${bad} page(s) move under reduced motion` : 'no motion under reduced motion');
process.exit(bad ? 1 : 0);
