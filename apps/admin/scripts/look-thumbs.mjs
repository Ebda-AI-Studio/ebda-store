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

const only = process.argv.slice(2);
const todo = only.length ? looks.filter(l => only.includes(l.id)) : looks;
mkdirSync(outDir, { recursive: true });
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
