#!/usr/bin/env node
/**
 * Generates apps/admin/public/looks/<lookId>.webp: the first screen of each look's phone, 360px wide,
 * for the admin LookPicker. Source of truth is the already-exported marketing fragments
 * (apps/marketing/public/looks/<template>.html, phones `ph-<template>-<a|b|c>`); nothing here
 * redefines a look. Re-run after `npm run looks` in apps/marketing changes the fragments.
 *
 *   node apps/admin/scripts/look-thumbs.mjs [lookId ...]
 *
 * Needs macOS Google Chrome, `sips` and `cwebp` (brew install webp). No npm dependencies.
 *
 * Storefront mode (a BUILT look, Ruling B1-46): capture the real storefront instead of the mock,
 * from a local seeded store per look (`scripts/storedemo/seed.mjs --local-look-stores` seeds
 * qamar-atelier / qamar-lookbook / qamar-vitrine; `{slug}` = the look id with '.' -> '-'):
 *
 *   node apps/admin/scripts/look-thumbs.mjs --from-storefront 'http://{slug}.localhost:3100' \
 *     qamar.atelier qamar.lookbook qamar.vitrine
 *
 * Deterministic: 390x844 phone, Arabic, reduced motion, cookie banner pre-dismissed, fixed chrome
 * (tab bar, sticky bars, dev overlay) hidden, a 390x488 clip from the top of the header (the demo
 * announcement above it is left out). When the look's signature section (SIGNATURE below) would
 * fall outside the clip, the clip moves down just enough to show it whole. Uses the repo's
 * Playwright (root devDependency) in this mode only.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const marketing = join(repo, 'apps/marketing');
const outDir = join(repo, 'apps/admin/public/looks');
const PHONE_W = 390; // the phone is designed at this width
const SHOT_H = 488; // 4/5 of the width: the picker card's aspect ratio
const THUMB_W = 360;
const QUALITY = '70';

// Look id -> (template, letter) straight from the shared registry source.
const registry = readFileSync(join(repo, 'packages/shared/src/looks/registry.ts'), 'utf8');
const looks = [
  ...registry.matchAll(/id: '([a-z]+\.[a-z0-9-]+)',\s*template: '([a-z]+)',\s*letter: '([ABC])'/g),
].map(m => ({ id: m[1], template: m[2], letter: m[3].toLowerCase() }));
const EXPECTED_LOOKS = 15; // 5 templates x 3 looks
if (looks.length !== EXPECTED_LOOKS) {
  throw new Error(`parsed ${looks.length} looks from the registry, expected ${EXPECTED_LOOKS}`);
}

const fontsTs = readFileSync(join(marketing, 'src/lib/looks-fonts.ts'), 'utf8');
const fontsFor = template => {
  const block = fontsTs.match(new RegExp(`${template}: \\[([^\\]]*)\\]`))?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map(m => m[1]);
};

const args = process.argv.slice(2);
const sfAt = args.indexOf('--from-storefront');
const storefront = sfAt >= 0 ? args[sfAt + 1] : null;
if (sfAt >= 0 && !storefront) throw new Error('--from-storefront needs a base URL with {slug}');
const only = args.filter((a, i) => sfAt < 0 || (i !== sfAt && i !== sfAt + 1));
const todo = only.length ? looks.filter(l => only.includes(l.id)) : looks;
mkdirSync(outDir, { recursive: true });

/** The section that makes a look recognisable; the clip always shows it whole when present. */
// Atelier and Lookbook read from their first screen (hero / collage under the header); Vitrine's
// occasion bands sit below the fold, so its clip moves down to the first band.
const SIGNATURE = {
  'qamar.vitrine': '[data-tile-shape="band"] li',
};

async function fromStorefront(list) {
  const { createRequire } = await import('node:module');
  const { chromium } = createRequire(join(repo, 'package.json'))('playwright');
  const consent = encodeURIComponent(JSON.stringify({ v: 1, marketing: false, analytics: false }));
  const work = mkdtempSync(join(tmpdir(), 'look-thumbs-sf-'));
  const browser = await chromium.launch();
  try {
    for (const look of list) {
      const url = new URL(storefront.replace('{slug}', look.id.replace('.', '-')));
      const ctx = await browser.newContext({
        viewport: { width: PHONE_W, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        reducedMotion: 'reduce',
      });
      await ctx.addCookies([
        { name: 'force-language', value: 'ar', domain: url.hostname, path: '/' },
        { name: 'force-cookie-consent', value: consent, domain: url.hostname, path: '/' },
      ]);
      const page = await ctx.newPage();
      await page.goto(url.href, { waitUntil: 'networkidle', timeout: 180000 });
      await page.evaluate(() => document.fonts?.ready);
      const y = await page.evaluate(
        ({ sel, h }) => {
          document.querySelectorAll('nextjs-portal').forEach(el => el.remove());
          for (const el of document.querySelectorAll('body *'))
            if (getComputedStyle(el).position === 'fixed') el.style.display = 'none';
          const header = document.querySelector('header');
          const top = header ? header.getBoundingClientRect().top + window.scrollY : 0;
          const sig = sel ? document.querySelector(sel) : null;
          const bottom = sig ? sig.getBoundingClientRect().bottom + window.scrollY : 0;
          return Math.round(Math.max(top, bottom - h));
        },
        { sel: SIGNATURE[look.id] ?? null, h: SHOT_H }
      );
      await page.waitForTimeout(400);
      const png = join(work, `${look.id}.png`);
      await page.screenshot({
        path: png,
        clip: { x: 0, y, width: PHONE_W, height: SHOT_H },
        fullPage: true,
      });
      await ctx.close();
      execFileSync('sips', ['--resampleWidth', String(THUMB_W), png], { stdio: 'ignore' });
      execFileSync('cwebp', ['-quiet', '-q', QUALITY, png, '-o', join(outDir, `${look.id}.webp`)]);
      console.log('wrote', `${look.id}.webp`, `(storefront, clip y=${y})`);
    }
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (storefront) {
  // Only built looks have a storefront to capture: name them, never "all 15".
  if (!only.length) throw new Error('--from-storefront needs the look ids to capture');
  await fromStorefront(todo);
  process.exit(0);
}
const work = mkdtempSync(join(tmpdir(), 'look-thumbs-'));
const imgBase = pathToFileURL(join(marketing, 'public/looks/img')).href;

try {
  for (const look of todo) {
    const fragment = readFileSync(join(marketing, `public/looks/${look.template}.html`), 'utf8');
    const [style, ...phones] = fragment.split('<!--look-->');
    const phone = phones.find(p => p.includes(`id="ph-${look.template}-${look.letter}"`));
    if (!phone) throw new Error(`${look.id}: phone ph-${look.template}-${look.letter} not found`);
    const css = fontsFor(look.template)
      .map(
        f =>
          `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${f}&display=swap">`
      )
      .join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${PHONE_W}">${css}
<style>html,body{margin:0;padding:0;background:#fff}#f{width:${PHONE_W}px;height:${SHOT_H}px;overflow:hidden}</style>
${style}</head><body><div id="f">${phone.replaceAll('/looks/img/', `${imgBase}/`)}</div></body></html>`;
    const page = join(work, `${look.id}.html`);
    const png = join(work, `${look.id}.png`);
    writeFileSync(page, html);
    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--hide-scrollbars',
        '--disable-gpu',
        '--allow-file-access-from-files',
        '--force-device-scale-factor=1',
        `--window-size=${PHONE_W},${SHOT_H}`,
        '--virtual-time-budget=8000',
        `--screenshot=${png}`,
        pathToFileURL(page).href,
      ],
      { stdio: 'ignore' }
    );
    execFileSync('sips', ['--resampleWidth', String(THUMB_W), png], { stdio: 'ignore' });
    execFileSync('cwebp', ['-quiet', '-q', QUALITY, png, '-o', join(outDir, `${look.id}.webp`)]);
    console.log('wrote', `${look.id}.webp`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
