// Generate PWA / favicon PNG variants for the admin app from the
// FSA wordmark SVG at apps/admin/public/favicon.svg.
//
// Run from repo root:
//   node scripts/generate-admin-icons.mjs
//
// Outputs (all under apps/admin/public/):
//   - icon-192.png  (192x192) — manifest + apple-touch-icon
//   - icon.png      (512x512) — manifest "any" + "maskable"
//
// The SVG itself stays as the primary favicon (Chrome/Firefox/Safari
// all support SVG favicons now). PNGs are needed because iOS Safari
// won't accept an SVG for the home-screen icon and OneSignal push
// permission silently fails on iPhone without a real icon.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const inSvg = resolve(root, 'apps/admin/public/favicon.svg');
const outDir = resolve(root, 'apps/admin/public');

const svgBuffer = readFileSync(inSvg);

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon.png', size: 512 },
];

for (const { name, size } of targets) {
  const out = resolve(outDir, name);
  await sharp(svgBuffer).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
  console.log(`✓ ${name} (${size}x${size})`);
}
