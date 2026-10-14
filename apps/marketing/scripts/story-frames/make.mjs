// Renders the four story frames (public/devices/dahab-story-<n>-900.{avif,webp}) from the Dahab
// look A fragment (public/looks/dahab.html), the same markup the looks section shows:
// (a 34px strip at the top is left clear for the phone's dynamic island)
//   1 name + logo     header only, nothing else in the store yet
//   2 products        chips and the first four products of the grid
//   3 colours/photos  the styled first screen: header, hero photo, caption, chips
//   4 first order     the full grid scrolled up, with a cart bar at the foot
// A phone screen is 390x844; frames are captured at 900px wide (DPR 900/390) like the old strip.
//   CHROME_PATH=/path/to/chrome node scripts/story-frames/make.mjs     (from apps/marketing)
// Needs network for the template's Google Fonts. Writes src/lib/story-frames.ts too.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const sharp = require('sharp');

const W = 900;
const H = Math.round((W * 844) / 390);
const [css, a] = (() => {
  const [c, ...looks] = readFileSync(path.join(root, 'public/looks/dahab.html'), 'utf8').split(
    '<!--look-->'
  );
  return [c.replace(/^<style>|<\/style>$/g, ''), looks[0]];
})();
const fonts = (
  readFileSync(path.join(root, 'src/lib/looks-fonts.ts'), 'utf8').match(
    /dahab: \[([^\]]*)\]/
  )?.[1] ?? ''
)
  .split(',')
  .map(s => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);
const fontHref = `https://fonts.googleapis.com/css2?${fonts.map(f => `family=${f}`).join('&')}&display=swap`;

const page_html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${fontHref}">
<style>html,body{margin:0;background:#fff}#phone{width:390px;height:844px;overflow:hidden;position:relative;box-sizing:border-box;padding-top:34px}${css}</style>
<div id="phone">${a}</div>`;

// Frame-specific DOM state, applied to the fragment's own sections.
const frames = [
  scr => {
    for (const s of scr.querySelectorAll('.x-hero,.chips,.g2,.eng,.ft')) s.style.display = 'none';
  },
  scr => {
    for (const s of scr.querySelectorAll('.x-hero,.eng,.ft')) s.style.display = 'none';
    [...scr.querySelectorAll('.g2 > *')].slice(4).forEach(n => (n.style.display = 'none'));
  },
  scr => {
    for (const s of scr.querySelectorAll('.eng,.ft')) s.style.display = 'none';
  },
  scr => {
    scr.querySelector('.x-hero').style.display = 'none';
    scr.scrollTop = scr.querySelector('.g2').offsetTop - 72;
    const bar = document.createElement('div');
    bar.setAttribute(
      'style',
      "position:absolute;inset:auto 0 0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:#121212;color:#fff;font-family:'IBM Plex Sans Arabic',sans-serif;direction:rtl"
    );
    bar.innerHTML =
      '<span style="font-size:13px;line-height:1.5"><b style="display:block;font-size:15px">9,800 ج.م</b>منتج واحد في السلة</span>' +
      '<span style="background:#fff;color:#121212;padding:11px 18px;font-weight:700;font-size:14px">كمّل الطلب</span>';
    document.getElementById('phone').appendChild(bar);
  },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox'],
});
const out = path.join(root, 'public/devices');
mkdirSync(out, { recursive: true });
const meta = [];
for (let i = 0; i < frames.length; i++) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: W / 390,
  });
  const page = await ctx.newPage();
  // The fragment references /looks/img/*.webp: serve the page and those files from public/ on a fake host.
  await page.route('http://frag.test/**', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: page_html });
    const f = path.join(root, 'public', decodeURIComponent(u.pathname));
    return existsSync(f) ? route.fulfill({ path: f }) : route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://frag.test/', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(`(${frames[i].toString()})(document.getElementById('ph-dahab-a'))`);
  await page.waitForTimeout(400);
  const png = await page.locator('#phone').screenshot({ type: 'png' });
  const name = `dahab-story-${i + 1}-${W}`;
  const img = sharp(png).resize(W, H);
  await img
    .clone()
    .avif({ quality: 60 })
    .toFile(path.join(out, `${name}.avif`));
  await img
    .clone()
    .webp({ quality: 78 })
    .toFile(path.join(out, `${name}.webp`));
  meta.push({ name, w: W, h: H });
  await ctx.close();
}
await browser.close();
writeFileSync(
  path.join(root, 'src/lib/story-frames.ts'),
  `// Generated by scripts/story-frames/make.mjs. Do not edit by hand.
// Screenshots of the Dahab look A fragment (public/looks/dahab.html) at 390x844, one per story step.
export const STORY_FRAMES = [
${meta.map(m => `  { name: '${m.name}', w: ${m.w}, h: ${m.h} },`).join('\n')}
] as const;
`
);
console.log('story frames:', meta.map(m => m.name).join(', '));
