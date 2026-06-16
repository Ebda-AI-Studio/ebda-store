#!/usr/bin/env node
/**
 * FWB Admin (Force AI Store Admin / FSA) PWA icon generator.
 *
 * Reads `apps/admin/public/favicon.svg` (orange tile + FSA wordmark, the
 * single source of truth) and writes the six PNG sizes Android / iOS /
 * browser tabs need into `apps/admin/public/`.
 *
 * Idempotent — safe to re-run after editing favicon.svg. Outputs:
 *   icon-192x192.png       Android PWA / home screen
 *   icon-384x384.png       Android PWA splash sizes
 *   icon-512x512.png       Android PWA / maskable
 *   apple-touch-icon.png   iOS home screen (180×180)
 *   favicon-32.png         desktop browser tab
 *   favicon-16.png         legacy browser tab
 *
 * Run from the monorepo root or apps/admin/:
 *   node apps/admin/scripts/generate-pwa-icons.mjs
 *
 * Sharp resolves from the FWB monorepo root node_modules.
 *
 * Storefront uses a separate, per-tenant pipeline — do not extend this
 * script to handle store logos. See
 * docs/superpowers/plans/2026-05-04-storefront-per-store-pwa.md.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const SRC = path.join(APP, 'public', 'favicon.svg');
const PUB = path.join(APP, 'public');

if (!fs.existsSync(SRC)) {
  console.error(`Source SVG not found: ${SRC}`);
  process.exit(1);
}

async function loadSharp() {
  const candidates = [
    path.join(APP, 'node_modules', 'sharp'),
    path.resolve(APP, '..', '..', 'node_modules', 'sharp'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      const req = createRequire(pathToFileURL(path.join(dir, 'package.json')));
      return req('sharp');
    }
  }
  console.error('sharp not found. Run `npm install` at the monorepo root.');
  process.exit(1);
}

const sharp = await loadSharp();
const svg = fs.readFileSync(SRC);

const targets = [
  { out: 'icon-192x192.png', size: 192 },
  { out: 'icon-384x384.png', size: 384 },
  { out: 'icon-512x512.png', size: 512 },
  { out: 'apple-touch-icon.png', size: 180 },
  { out: 'favicon-32.png', size: 32 },
  { out: 'favicon-16.png', size: 16 },
];

for (const t of targets) {
  await sharp(svg, { density: Math.max(384, t.size * 2) })
    .resize(t.size, t.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUB, t.out));
  console.log(`✓ ${t.out} (${t.size}×${t.size})`);
}
