// Install the approved Ebda logo (2026-10-22 pack: the three-face doorway mark) into every app.
//
//   node scripts/generate-app-brand-icons.mjs
//
// Source of truth: brand/logo/svg/*.svg + brand/logo/png/* (approved 2026-10-22, masters live in
// Ebda-AI-Studio/business/brand/logo-2026-10-22). Exact-size approved PNGs are copied byte-for-byte;
// sizes the approved set does not ship (64, 192, 384, 512 maskable...) are rendered from the approved
// SVG with sharp. Dark-surface lockups are the light masters with ink and subtitle reversed to
// cream (#FAF8F3) and lift (#CBA873), exactly as the pack's own reversed logo does.
// Idempotent. Colours live in packages/shared/src/brand/index.ts.
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = p => resolve(root, p);
const SRC = f => P(`brand/logo/${f}`);
const ensure = p => mkdirSync(dirname(p), { recursive: true });
const reversed = f =>
  readFileSync(SRC(f), 'utf8').replaceAll('#0A0B0C', '#FAF8F3').replaceAll('#B08D57', '#CBA873');

const ICON = 'svg/05a-app-icon-1024.svg'; // rounded night tile
const FULLBLEED = 'svg/05e-app-icon-square-1024-fullbleed.svg'; // square, for maskable + store submission
const FAVICON = 'svg/05d-favicon-32.svg';

// [destination, source file under brand/logo/, render size when the approved PNG is not that size]
const COPIES = [
  // admin
  ['apps/admin/public/apple-touch-icon.png', 'png/apple-touch-icon.png'],
  ['apps/admin/public/favicon-16.png', 'png/favicon-16.png'],
  ['apps/admin/public/favicon-32.png', 'png/favicon-32.png'],
  ['apps/admin/public/icon-192.png', ICON, 192],
  ['apps/admin/public/icon-192x192.png', FULLBLEED, 192],
  ['apps/admin/public/icon-384x384.png', FULLBLEED, 384],
  ['apps/admin/public/icon-512x512.png', FULLBLEED, 512],
  ['apps/admin/public/icon.png', 'png/app-icon-512.png'],
  // orders
  ['apps/orders/public/apple-touch-icon.png', 'png/apple-touch-icon.png'],
  ['apps/orders/public/favicon.png', FAVICON, 64],
  ['apps/orders/public/icons/icon-192.png', ICON, 192],
  ['apps/orders/public/icons/icon-512.png', 'png/app-icon-512.png'],
  ['apps/orders/public/icons/icon-maskable-512.png', FULLBLEED, 512],
  // web (platform default only; merchant stores serve their own icons)
  ['apps/web/public/apple-touch-icon.png', 'png/apple-touch-icon.png'],
  ['apps/web/public/apple-touch-icon-precomposed.png', 'png/apple-touch-icon.png'],
  ['apps/web/public/icon-192.png', ICON, 192],
  ['apps/web/public/icon-512.png', 'png/app-icon-512.png'],
  ['apps/web/public/icon-maskable-192.png', FULLBLEED, 192],
  ['apps/web/public/icon-maskable-512.png', FULLBLEED, 512],
  ['apps/web/public/icon.png', 'png/app-icon-512.png'],
  ['apps/web/src/app/icon.png', 'png/app-icon-512.png'],
  ['apps/web/src/app/apple-icon.png', 'png/apple-touch-icon.png'],
  // marketing, help, docs
  ['apps/marketing/public/apple-touch-icon.png', 'png/apple-touch-icon.png'],
  ['apps/marketing/public/icon-192.png', ICON, 192],
  ['apps/marketing/public/icon-512.png', 'png/app-icon-512.png'],
  ['apps/marketing/public/favicon-32.png', 'png/favicon-32.png'],
  ['apps/help/public/apple-touch-icon.png', 'png/apple-touch-icon.png'],
  ['apps/help/public/favicon-32.png', 'png/favicon-32.png'],
  ['apps/docs/public/apple-touch-icon.png', 'png/apple-touch-icon.png'],
  ['apps/docs/public/favicon-32.png', 'png/favicon-32.png'],
];
for (const [dest, src, size] of COPIES) {
  ensure(P(dest));
  if (size) await sharp(SRC(src), { density: 288 }).resize(size, size).png().toFile(P(dest));
  else copyFileSync(SRC(src), P(dest));
  console.log(`ok ${dest}`);
}

// favicon.ico (16/32/48) from the approved favicon PNGs.
function writeIco(path, files) {
  const frames = files.map(([size, f]) => ({ size, data: readFileSync(SRC(f)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries = frames.map(f => {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size, 0);
    e.writeUInt8(f.size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += f.data.length;
    return e;
  });
  ensure(path);
  writeFileSync(path, Buffer.concat([header, ...entries, ...frames.map(f => f.data)]));
}
const ICO = [
  [16, 'png/favicon-16.png'],
  [32, 'png/favicon-32.png'],
  [48, 'png/favicon-48.png'],
];
for (const app of ['web', 'marketing', 'help', 'docs'])
  writeIco(P(`apps/${app}/public/favicon.ico`), ICO);

// SVGs. logo.svg = the gold three-face mark (reads on light and dark); logo-white.svg = flat white mark (on a
// coloured tile). logo-on-light.svg is the same gold mark: kept as its own file so the light/dark <img> pairs in
// admin + orders keep resolving.
const SVGS = [
  ['apps/admin/public/logo.svg', 'svg/03d-symbol-gold.svg'],
  ['apps/admin/public/logo-on-light.svg', 'svg/03d-symbol-gold.svg'],
  ['apps/admin/public/logo-white.svg', 'svg/03f-symbol-white.svg'],
  ['apps/admin/public/favicon.svg', FAVICON],
  ['apps/orders/public/logo.svg', 'svg/03d-symbol-gold.svg'],
  ['apps/orders/public/logo-on-light.svg', 'svg/03d-symbol-gold.svg'],
  ['apps/orders/public/icon.svg', FAVICON],
  ['apps/web/public/logo.svg', 'svg/03d-symbol-gold.svg'],
  ['apps/web/public/favicon.svg', FAVICON],
  ['apps/marketing/public/logo.svg', 'svg/03d-symbol-gold.svg'],
  ['apps/marketing/public/icon.svg', FAVICON],
  ['apps/help/public/icon.svg', FAVICON],
  ['apps/docs/public/icon.svg', FAVICON],
  // Product lockups (mark + "Ebda Store"; text outlined): light = for light surfaces.
  ['apps/admin/public/lockup-light.svg', 'svg/04a-product-store.svg'],
  ['apps/orders/public/lockup-light.svg', 'svg/04a-product-store.svg'],
];
// dark = reversed for night surfaces; lockup-ar-dark = bilingual (ابدأ + Ebda AI Studio) for Arabic pages.
const DARK_LOCKUPS = [
  ['apps/admin/public/lockup-dark.svg', 'svg/04a-product-store.svg'],
  ['apps/orders/public/lockup-dark.svg', 'svg/04a-product-store.svg'],
  ['apps/web/public/lockup-dark.svg', 'svg/04a-product-store.svg'],
  ['apps/web/public/lockup-ar-dark.svg', 'svg/02c-lockup-bilingual.svg'],
  ['apps/marketing/public/lockup-dark.svg', 'svg/04a-product-store.svg'],
  ['apps/help/public/lockup-dark.svg', 'svg/04a-product-store.svg'],
  ['apps/docs/public/lockup-dark.svg', 'svg/04a-product-store.svg'],
];
for (const [dest, src] of SVGS) {
  ensure(P(dest));
  copyFileSync(SRC(src), P(dest));
}
for (const [dest, src] of DARK_LOCKUPS) {
  ensure(P(dest));
  writeFileSync(P(dest), reversed(src));
}
console.log('ok svg marks');

// Hosted PNG for transactional email (many mail clients drop SVG): the bare gold mark, transparent, 256px
// tall. Emails scale it WHOLE into the 160x64 logo box (never cropped); the store-name line under it carries
// the words.
await sharp(SRC('svg/03d-symbol-gold.svg'), { density: 288 })
  .resize({ height: 256 })
  .png({ compressionLevel: 9 })
  .toFile(P('apps/marketing/public/email-logo.png'));
console.log('ok apps/marketing/public/email-logo.png');
