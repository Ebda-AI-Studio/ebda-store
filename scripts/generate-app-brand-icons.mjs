// Install the approved Ebda "open door" mark into every app.
//
//   node scripts/generate-app-brand-icons.mjs
//
// Source of truth: brand/logo/*.svg + brand/logo/png/* (approved, final).
// Exact-size approved PNGs are copied byte-for-byte; sizes the approved set
// does not ship (64, 384) are rendered from the approved SVG with sharp.
// Idempotent. Colours live in packages/shared/src/brand/index.ts.
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = p => resolve(root, p);
const SRC = f => P(`brand/logo/${f}`);
const ensure = p => mkdirSync(dirname(p), { recursive: true });

// [destination, source file under brand/logo/, render size when the approved PNG is not that size]
const COPIES = [
  // admin
  ['apps/admin/public/apple-touch-icon.png', 'png/apple-touch-icon-180.png'],
  ['apps/admin/public/favicon-16.png', 'png/favicon-16.png'],
  ['apps/admin/public/favicon-32.png', 'png/favicon-32.png'],
  ['apps/admin/public/icon-192.png', 'png/icon-192.png'],
  ['apps/admin/public/icon-192x192.png', 'png/maskable-192.png'],
  ['apps/admin/public/icon-384x384.png', 'ebda-maskable.svg', 384],
  ['apps/admin/public/icon-512x512.png', 'png/maskable-512.png'],
  ['apps/admin/public/icon.png', 'png/icon-512.png'],
  // orders
  ['apps/orders/public/apple-touch-icon.png', 'png/apple-touch-icon-180.png'],
  ['apps/orders/public/favicon.png', 'ebda-favicon.svg', 64],
  ['apps/orders/public/icons/icon-192.png', 'png/icon-192.png'],
  ['apps/orders/public/icons/icon-512.png', 'png/icon-512.png'],
  ['apps/orders/public/icons/icon-maskable-512.png', 'png/maskable-512.png'],
  // web (platform default only; merchant stores serve their own icons)
  ['apps/web/public/apple-touch-icon.png', 'png/apple-touch-icon-180.png'],
  ['apps/web/public/apple-touch-icon-precomposed.png', 'png/apple-touch-icon-180.png'],
  ['apps/web/public/icon-192.png', 'png/icon-192.png'],
  ['apps/web/public/icon-512.png', 'png/icon-512.png'],
  ['apps/web/public/icon-maskable-192.png', 'png/maskable-192.png'],
  ['apps/web/public/icon-maskable-512.png', 'png/maskable-512.png'],
  ['apps/web/public/icon.png', 'png/icon-512.png'],
  ['apps/web/src/app/icon.png', 'png/icon-512.png'],
  ['apps/web/src/app/apple-icon.png', 'png/apple-touch-icon-180.png'],
  // marketing, help, docs
  ['apps/marketing/public/apple-touch-icon.png', 'png/apple-touch-icon-180.png'],
  ['apps/marketing/public/icon-192.png', 'png/icon-192.png'],
  ['apps/marketing/public/icon-512.png', 'png/icon-512.png'],
  ['apps/marketing/public/favicon-32.png', 'png/favicon-32.png'],
  ['apps/help/public/apple-touch-icon.png', 'png/apple-touch-icon-180.png'],
  ['apps/help/public/favicon-32.png', 'png/favicon-32.png'],
  ['apps/docs/public/apple-touch-icon.png', 'png/apple-touch-icon-180.png'],
  ['apps/docs/public/favicon-32.png', 'png/favicon-32.png'],
];
for (const [dest, src, size] of COPIES) {
  ensure(P(dest));
  if (size) await sharp(SRC(src), { density: 512 }).resize(size, size).png().toFile(P(dest));
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

// SVGs. logo.svg = gold mark (dark surfaces); logo-on-light.svg = charcoal arch (light surfaces).
const SVGS = [
  ['apps/admin/public/logo.svg', 'ebda-mark.svg'],
  ['apps/admin/public/logo-on-light.svg', 'ebda-mark-on-light.svg'],
  ['apps/admin/public/logo-white.svg', 'ebda-mark-white.svg'],
  ['apps/admin/public/favicon.svg', 'ebda-favicon.svg'],
  ['apps/orders/public/logo.svg', 'ebda-mark.svg'],
  ['apps/orders/public/logo-on-light.svg', 'ebda-mark-on-light.svg'],
  ['apps/orders/public/icon.svg', 'ebda-favicon.svg'],
  ['apps/web/public/logo.svg', 'ebda-mark.svg'],
  ['apps/web/public/favicon.svg', 'ebda-favicon.svg'],
  ['apps/marketing/public/logo.svg', 'ebda-mark.svg'],
  ['apps/marketing/public/icon.svg', 'ebda-favicon.svg'],
  ['apps/help/public/icon.svg', 'ebda-favicon.svg'],
  ['apps/docs/public/icon.svg', 'ebda-favicon.svg'],
  // lockups (mark + ebda + ابدأ, text outlined): dark = for night surfaces, light = for light surfaces
  ['apps/admin/public/lockup-dark.svg', 'ebda-lockup-dark.svg'],
  ['apps/admin/public/lockup-light.svg', 'ebda-lockup-light.svg'],
  ['apps/orders/public/lockup-dark.svg', 'ebda-lockup-dark.svg'],
  ['apps/orders/public/lockup-light.svg', 'ebda-lockup-light.svg'],
  ['apps/web/public/lockup-dark.svg', 'ebda-lockup-dark.svg'],
  ['apps/marketing/public/lockup-dark.svg', 'ebda-lockup-dark.svg'],
  ['apps/help/public/lockup-dark.svg', 'ebda-lockup-dark.svg'],
  ['apps/docs/public/lockup-dark.svg', 'ebda-lockup-dark.svg'],
];
for (const [dest, src] of SVGS) {
  ensure(P(dest));
  copyFileSync(SRC(src), P(dest));
}
console.log('ok svg marks');

// Hosted PNG for transactional email (many mail clients drop SVG): the 600x200
// lockup, shown at 160px wide.
copyFileSync(SRC('png/email-logo-600.png'), P('apps/marketing/public/email-logo.png'));
console.log('ok apps/marketing/public/email-logo.png');
