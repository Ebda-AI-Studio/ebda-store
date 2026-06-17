// Generate Force AI brand app icons: white eagle on orange rounded square,
// with an optional descriptive WORD underneath (matching the Orders app icon
// Ahmad approved). Small favicons (svg / 16 / 32 / ico) stay BARE (word is
// illegible at tab size — same convention as apps/orders/public/icon.svg);
// large PWA / home-screen icons (>=180px) carry the word.
//
//   node scripts/generate-app-brand-icons.mjs
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const ORANGE = '#ff6e01';

// Pull the two white eagle paths straight from the approved Orders icon so the
// glyph is byte-identical to the one Ahmad likes.
const ordersSvg = readFileSync(resolve(root, 'apps/orders/public/icon.svg'), 'utf8');
const EAGLE_PATHS = [...ordersSvg.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map(m => m[1]);
if (EAGLE_PATHS.length !== 2) throw new Error(`expected 2 eagle paths, got ${EAGLE_PATHS.length}`);

const eagleGroup = (cx, cy, scale) =>
  `<g fill="#ffffff" transform="translate(${cx} ${cy}) scale(${scale}) translate(-154 -130.73)">` +
  EAGLE_PATHS.map(d => `<path d="${d}"/>`).join('') +
  `</g>`;

/** 512x512 master SVG. word=null → bare (small favicons); else worded. */
export function buildSvg(word) {
  const rect = `<rect width="512" height="512" rx="112" fill="${ORANGE}"/>`;
  if (!word) {
    // Bare: eagle centred, slightly above middle (matches orders icon.svg).
    return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${rect}${eagleGroup(256, 244, 1.32)}</svg>`;
  }
  // Worded: eagle lifted to the top 60%, word in the bottom band. Size the
  // font so short words stay bold/large but long words (DASHBOARD/WHATSAPP)
  // keep side padding instead of running edge-to-edge. Usable width ~430.
  const w = word.toUpperCase();
  const spacing = 1;
  const fs = Math.min(92, Math.floor((430 - (w.length - 1) * spacing) / (w.length * 0.66)));
  const text =
    `<text x="256" y="440" text-anchor="middle" ` +
    `font-family="Helvetica, Arial, sans-serif" font-weight="700" ` +
    `font-size="${fs}" letter-spacing="${spacing}" fill="#ffffff">${w}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${rect}${eagleGroup(256, 190, 1.0)}${text}</svg>`;
}

async function png(word, size) {
  return sharp(Buffer.from(buildSvg(word))).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

/** Minimal PNG-in-ICO packer (modern browsers accept PNG frames). */
async function writeIco(outPath, sizes, word) {
  const frames = await Promise.all(sizes.map(async s => ({ size: s, data: await png(word, s) })));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries = [], datas = [];
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(f.data.length, 8); e.writeUInt32LE(offset, 12);
    offset += f.data.length; entries.push(e); datas.push(f.data);
  }
  writeFileSync(outPath, Buffer.concat([header, ...entries, ...datas]));
}

// ── Per-app targets ────────────────────────────────────────────────────────
// word: the label under the eagle. file list: name → {size, worded}.
const APPS = [
  {
    name: 'admin', word: 'DASHBOARD', dir: resolve(root, 'apps/admin/public'),
    svg: 'favicon.svg',
    ico: { name: null }, // admin has no favicon.ico
    files: [
      { name: 'favicon-16.png', size: 16, worded: true },
      { name: 'favicon-32.png', size: 32, worded: true },
      { name: 'apple-touch-icon.png', size: 180, worded: true },
      { name: 'icon-192.png', size: 192, worded: true },
      { name: 'icon-192x192.png', size: 192, worded: true },
      { name: 'icon-384x384.png', size: 384, worded: true },
      { name: 'icon-512x512.png', size: 512, worded: true },
      { name: 'icon.png', size: 512, worded: true },
    ],
  },
  {
    name: 'web', word: 'SHOP', dir: resolve(root, 'apps/web/public'),
    svg: 'favicon.svg',
    ico: { name: 'favicon.ico', sizes: [16, 32, 48] },
    files: [
      { name: 'apple-touch-icon.png', size: 180, worded: true },
      { name: 'apple-touch-icon-precomposed.png', size: 180, worded: true },
      { name: 'icon-192.png', size: 192, worded: true },
      { name: 'icon-512.png', size: 512, worded: true },
      { name: 'icon.png', size: 512, worded: true },
    ],
    extra: [
      { path: resolve(root, 'apps/web/src/app/icon.png'), size: 512, worded: true },
      { path: resolve(root, 'apps/web/src/app/apple-icon.png'), size: 180, worded: true },
    ],
  },
];

for (const app of APPS) {
  for (const f of app.files) {
    writeFileSync(resolve(app.dir, f.name), await png(f.worded ? app.word : null, f.size));
    console.log(`✓ ${app.name}/${f.name} (${f.size}, ${f.worded ? app.word : 'bare'})`);
  }
  for (const x of app.extra ?? []) {
    writeFileSync(x.path, await png(x.worded ? app.word : null, x.size));
    console.log(`✓ ${app.name}/${x.path.split('/').slice(-2).join('/')} (${x.size})`);
  }
  // Worded everywhere — incl. the SVG favicon + .ico — so each installed PWA /
  // tab is distinguishable by its label even at small sizes (Ahmad's call).
  writeFileSync(resolve(app.dir, app.svg), buildSvg(app.word));
  console.log(`✓ ${app.name}/${app.svg} (worded svg)`);
  if (app.ico?.name) {
    await writeIco(resolve(app.dir, app.ico.name), app.ico.sizes, app.word);
    console.log(`✓ ${app.name}/${app.ico.name} (${app.ico.sizes.join('/')})`);
  }
}
