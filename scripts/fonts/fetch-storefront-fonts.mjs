#!/usr/bin/env node
// Regenerate the storefront's self-hosted, subsetted web fonts (docs/RULINGS.md PERF-STORE-4).
//
//   node scripts/fonts/fetch-storefront-fonts.mjs [--check]
//
// Why not next/font/google: it ships every face of a family as separate
// per-script files and PRELOADS all of them on every page (the four Arabic
// weights were downloaded by English visitors, and an Arabic page fetched a
// latin + an arabic file per weight, 10 woff2 / 323 KB on the Dahab home).
// Here each (family, weight) is ONE woff2 holding exactly the glyphs the
// storefront can render in it, fetched from the Google Fonts CSS API with its
// `text=` subsetter (which keeps the shaping tables the kept glyphs need).
// The files are committed under apps/web/src/fonts/; nothing is downloaded at
// build time, so the build is hermetic.
//
// The glyph sets are the contract:
//   LATIN  - ASCII, Latin-1, the typographic punctuation / currency signs / symbols
//            Google's own `latin` subset carries (accented letters beyond Latin-1
//            fall back to the next family, as they do for any uncovered glyph).
//   ARABIC - the Arabic block U+0600-06FF (letters, Arabic-Indic digits, marks),
//            ZWNJ/ZWJ/LRM/RLM, the Allah / rial ligature signs. Pre-shaped
//            presentation forms (U+FB50-FDFF, U+FE70-FEFF) are NOT kept: typed text
//            is logical, and the browser falls back for pasted legacy text.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/web/src/fonts');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)).join('');
const chars = (...cps) => cps.map(c => String.fromCodePoint(c)).join('');

const LATIN =
  range(0x20, 0x7e) +
  range(0xa0, 0xff) +
  chars(0x131, 0x152, 0x153, 0x2bb, 0x2bc, 0x2c6, 0x2da, 0x2dc) +
  range(0x2010, 0x2015) + // hyphens / dashes
  chars(0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030) +
  chars(0x2039, 0x203a, 0x20ac, 0x2122, 0x2191, 0x2193, 0x2212, 0x2215);
const ARABIC =
  range(0x600, 0x6ff) + range(0x200c, 0x200f) + chars(0xfdf2, 0xfdfc, 0x25cc, 0xa0);

const FONTS = [
  { file: 'plus-jakarta-sans-var.woff2', family: 'Plus Jakarta Sans', axis: 'wght@400..800', text: LATIN },
  { file: 'marcellus-400.woff2', family: 'Marcellus', axis: 'wght@400', text: LATIN },
  ...[400, 500, 600, 700].map(w => ({
    file: `ibm-plex-sans-arabic-${w}.woff2`,
    family: 'IBM Plex Sans Arabic',
    axis: `wght@${w}`,
    text: ARABIC + LATIN,
  })),
  { file: 'amiri-700.woff2', family: 'Amiri', axis: 'wght@700', text: ARABIC + LATIN },
];

const check = process.argv.includes('--check');
mkdirSync(OUT, { recursive: true });
for (const f of FONTS) {
  const text = [...new Set([...f.text])].join('');
  const url = `https://fonts.googleapis.com/css2?family=${f.family.replace(/ /g, '+')}:${f.axis}&display=swap&text=${encodeURIComponent(text)}`;
  const css = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  const m = /src:\s*url\((https:[^)]+)\)\s*format\('woff2'\)/.exec(css);
  if (!m) throw new Error(`${f.family}: no woff2 in CSS response:\n${css.slice(0, 300)}`);
  const bin = Buffer.from(await (await fetch(m[1])).arrayBuffer());
  console.log(`${f.file.padEnd(34)} ${String(Math.round(bin.length / 1024)).padStart(4)} KB  (${[...text].length} chars)`);
  if (!check) writeFileSync(resolve(OUT, f.file), bin);
}
