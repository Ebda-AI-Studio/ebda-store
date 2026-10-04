// Generates public/og.svg + public/og.png (1200x630): the Nile-at-night lights
// (each light is a store) in Antique Gold on night. Deterministic (seeded).
// Latin text only: no Arabic font is bundled, and a wrong fallback glyph would be
// worse than none. Re-run with `npm run og -w apps/marketing`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const NIGHT = '#0A0B0C';
const LIFT = '#CBA873';
const GOLD = '#B08D57';
let seed = 11;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;

const W = 1200;
const H = 630;
const cx = 900;
const deltaY = 250;
let dots = '';
for (let i = 0; i < 700; i++) {
  let x;
  let y;
  if (rnd() < 0.46) {
    const t = Math.pow(rnd(), 0.8);
    const a = gauss() * 0.62;
    const r = t * (deltaY - 30);
    x = cx + Math.sin(a) * r * 2.1;
    y = deltaY - Math.cos(a) * r * 0.95;
  } else {
    y = deltaY + rnd() * (H - deltaY + 20);
    const k = (y - deltaY) / (H - deltaY);
    x = cx + Math.sin(k * 5.2) * 40 - k * 36 + gauss() * (10 + k * 5);
  }
  const lit = rnd() < 0.05;
  const r = lit ? 2.2 : 0.6 + rnd() * 0.7;
  const fill = lit ? LIFT : '#E9EEEC';
  const op = lit ? 1 : (0.25 + rnd() * 0.6).toFixed(2);
  if (lit)
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${LIFT}" opacity=".18"/>`;
  dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${fill}" opacity="${op}"/>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<title>Ebda: your business, your store, everything in one place.</title>
<defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stop-color="${NIGHT}" stop-opacity="0"/><stop offset="1" stop-color="${NIGHT}" stop-opacity=".85"/></linearGradient>
<linearGradient id="l" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${NIGHT}"/><stop offset=".55" stop-color="${NIGHT}" stop-opacity=".9"/><stop offset="1" stop-color="${NIGHT}" stop-opacity="0"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="${NIGHT}"/>${dots}
<rect width="${W}" height="${H}" fill="url(#f)"/><rect width="760" height="${H}" fill="url(#l)"/>
<text x="72" y="270" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="120" font-weight="700" letter-spacing="26" fill="#F3F5F4">EBDA</text>
<rect x="72" y="300" width="96" height="4" fill="${GOLD}"/>
<text x="72" y="372" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="38" fill="${LIFT}">Your business, your store,</text>
<text x="72" y="420" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="38" fill="${LIFT}">everything in one place.</text>
<text x="72" y="556" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="26" fill="#A9B1AF">ebda.app</text>
</svg>
`;
writeFileSync(path.join(dir, 'og.svg'), svg);
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(path.join(dir, 'og.png'));
console.log('wrote og.svg og.png');
