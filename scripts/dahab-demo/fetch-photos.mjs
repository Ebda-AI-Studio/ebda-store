#!/usr/bin/env node
// Download the Dahab demo photography (Unsplash License, see CREDITS.md) as
// pre-sized WebP. Storefront images on Cloudflare are served unoptimized, so the
// sizes here ARE the delivered sizes.
//   node scripts/dahab-demo/fetch-photos.mjs <outDir>
// Then upload <outDir>/dahab/* to the demo media bucket (README.md).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: fetch-photos.mjs <outDir>');
  process.exit(2);
}
const photos = JSON.parse(readFileSync(new URL('./photos.json', import.meta.url), 'utf8'));
const SIZES = {
  p: [['', 720, 900]],
  s: [['', 720, 900]],
  h: [
    ['', 1920, 1080],
    ['-mobile', 720, 960],
  ],
};
mkdirSync(join(out, 'dahab'), { recursive: true });
let n = 0;
for (const ph of photos) {
  for (const [suffix, w, h] of SIZES[ph.kind]) {
    const file = join(out, 'dahab', `${ph.asset}${suffix}.webp`);
    if (existsSync(file)) continue;
    const crop = ph.kind === 'h' ? 'faces,entropy' : 'entropy';
    // Byte budget per file (mobile Lighthouse): step the quality down until it fits.
    // The mobile hero is the phone LCP element: the tightest budget.
    const budget = ph.kind === 'h' ? (suffix ? 50_000 : 200_000) : 100_000;
    let q = ph.kind === 'h' ? 50 : 58;
    let bytes;
    for (;;) {
      const url = `${ph.raw}?w=${w}&h=${h}&fit=crop&crop=${crop}&fm=webp&q=${q}`;
      let res;
      for (let attempt = 1; ; attempt++) {
        try {
          res = await fetch(url);
          if (res.ok) break;
          throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          if (attempt >= 4) throw new Error(`${ph.asset}: ${err.message}`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
      bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length <= budget || q <= 30) break;
      q -= 8;
    }
    writeFileSync(file, bytes);
    n++;
  }
}
console.log(`fetched ${n} files into ${join(out, 'dahab')}`);
