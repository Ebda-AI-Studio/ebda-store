// Generate the Ebda brand marks + PWA icons for every app.
//
//   node scripts/generate-app-brand-icons.mjs
//
// The mark is a geometric "E" (three bars; the middle one in the lift gold —
// "each light is a store"). Colours are read from packages/shared/src/brand/
// index.ts (the single source of truth) so a palette change re-generates
// everything. Sizes of every raster file are preserved from the filename list
// below. Idempotent.
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brandSrc = readFileSync(resolve(root, 'packages/shared/src/brand/index.ts'), 'utf8');
const color = k => {
  const m = brandSrc.match(new RegExp(`${k}:\\s*'(#[0-9A-Fa-f]{6})'`));
  if (!m) throw new Error(`brand colour ${k} not found`);
  return m[1];
};
const NIGHT = color('night');
const GOLD = color('gold');
const LIFT = color('lift');

/** The E mark in a 64×64 box (transparent). */
const mark = (g = GOLD, l = LIFT) =>
  `<rect x="14" y="10" width="9" height="44" rx="2" fill="${g}"/>` +
  `<rect x="14" y="10" width="36" height="9" rx="2" fill="${g}"/>` +
  `<rect x="14" y="27.5" width="27" height="9" rx="2" fill="${l}"/>` +
  `<rect x="14" y="45" width="36" height="9" rx="2" fill="${g}"/>`;

/** Transparent symbol (gold) — used inline over a tile / header. */
export const logoSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Ebda">${mark()}</svg>\n`;

/** App tile: night square, gold mark. `bleed` = full-bleed (maskable / iOS), else rounded. */
export const tileSvg = (size = 512, bleed = false) => {
  const rx = bleed ? 0 : Math.round(size * 0.22);
  const inset = bleed ? 0.8 : 1; // maskable safe zone
  const s = (size / 64) * inset;
  const t = (size - 64 * s) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${rx}" fill="${NIGHT}"/>` +
    `<g transform="translate(${t} ${t}) scale(${s})">${mark()}</g></svg>`
  );
};

/** Horizontal wordmark: mark + "Ebda" (gold on night). */
export const wordmarkSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 64" width="220" height="64" role="img" aria-label="Ebda">` +
  `<rect width="220" height="64" rx="12" fill="${NIGHT}"/>` +
  `<g transform="translate(6 0)">${mark()}</g>` +
  `<text x="78" y="43" font-family="Geist, 'Helvetica Neue', Arial, sans-serif" font-size="32" font-weight="600" letter-spacing="0.5" fill="${GOLD}">Ebda</text>` +
  `</svg>\n`;

const png = (size, bleed) =>
  sharp(Buffer.from(tileSvg(512, bleed)))
    .resize(size, size)
    .png()
    .toBuffer();

async function writeIco(path, sizes) {
  const frames = [];
  for (const s of sizes) frames.push({ size: s, data: await png(s, false) });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries = [];
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += f.data.length;
    entries.push(e);
  }
  writeFileSync(path, Buffer.concat([header, ...entries, ...frames.map(f => f.data)]));
}

const P = p => resolve(root, p);
// [path, size, bleed]
const RASTERS = [
  ['apps/admin/public/apple-touch-icon.png', 180, true],
  ['apps/admin/public/favicon-16.png', 16, false],
  ['apps/admin/public/favicon-32.png', 32, false],
  ['apps/admin/public/icon-192.png', 192, true],
  ['apps/admin/public/icon-192x192.png', 192, true],
  ['apps/admin/public/icon-384x384.png', 384, true],
  ['apps/admin/public/icon-512x512.png', 512, true],
  ['apps/admin/public/icon.png', 512, false],
  ['apps/orders/public/favicon.png', 64, false],
  ['apps/orders/public/icons/icon-192.png', 192, false],
  ['apps/orders/public/icons/icon-512.png', 512, false],
  ['apps/orders/public/icons/icon-maskable-512.png', 512, true],
  ['apps/web/public/apple-touch-icon.png', 180, true],
  ['apps/web/public/apple-touch-icon-precomposed.png', 180, true],
  ['apps/web/public/icon-192.png', 192, false],
  ['apps/web/public/icon-512.png', 512, false],
  ['apps/web/public/icon.png', 512, false],
  ['apps/web/src/app/icon.png', 512, false],
  ['apps/web/src/app/apple-icon.png', 180, true],
];
for (const [p, size, bleed] of RASTERS) {
  mkdirSync(dirname(P(p)), { recursive: true });
  writeFileSync(P(p), await png(size, bleed));
  console.log(`ok ${p} (${size}${bleed ? ', full-bleed' : ''})`);
}
await writeIco(P('apps/web/public/favicon.ico'), [16, 32, 48]);

for (const app of ['admin', 'web', 'orders']) {
  writeFileSync(P(`apps/${app}/public/logo.svg`), logoSvg());
  writeFileSync(P(`apps/${app}/public/wordmark.svg`), wordmarkSvg());
}
writeFileSync(P('apps/admin/public/favicon.svg'), tileSvg(64));
writeFileSync(P('apps/web/public/favicon.svg'), tileSvg(64));
writeFileSync(P('apps/orders/public/icon.svg'), tileSvg(64));
console.log('ok svg marks + wordmarks');
