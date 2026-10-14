// Generates public/og.svg + public/og.png (1200x630): the light canvas of the site (#fafafa) with the
// approved lockup, the tagline and four template looks in phones (the looks' own photos from
// public/looks/img: Qamar, Souq, Jasmine, Dahab). No night, no gold field. All text is pre-outlined
// (brand/logo/ebda-lockup-light.svg + ebda-og-text.svg), so the output is identical on any machine.
// Re-run with `npm run og -w apps/marketing`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const brand = path.join(dir, '..', '..', '..', 'brand', 'logo');
const CANVAS = '#FAFAFA';
const INK = '#121314';
const MUTED = '#575C5D';
const GOLD = '#B08D57';
const W = 1200;
const H = 630;

const lockupSvg = readFileSync(path.join(brand, 'ebda-lockup-light.svg'), 'utf8');
const lockupInner = lockupSvg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const ogText = readFileSync(path.join(brand, 'ebda-og-text.svg'), 'utf8');
const pathOf = role => ogText.match(new RegExp(`data-role="${role}" d="([^"]+)"`))[1];
// viewBox is "18 16 288.496 96": scale 1.75 -> ~505x168 box, left-aligned at x=76.
const lockup = `<g transform="translate(76 80) scale(1.75) translate(-18 -16)">${lockupInner}</g>`;

// Four phones, staggered, each showing one look's hero photo inside a dark bezel.
const PHONES = [
  { img: 'qa__hero', x: 600, y: 90, w: 136, h: 290 },
  { img: 'sb__hero', x: 742, y: 190, w: 136, h: 290 },
  { img: 'jb__hero', x: 884, y: 90, w: 136, h: 290 },
  { img: 'da__hero', x: 1026, y: 190, w: 136, h: 290 },
];

const bezel = 7;
const layers = [];
for (const ph of PHONES) {
  const sw = ph.w - bezel * 2;
  const sh = ph.h - bezel * 2;
  const photo = await sharp(path.join(dir, 'looks', 'img', `${ph.img}.webp`))
    .resize(sw * 2, sh * 2, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sw * 2}" height="${sh * 2}"><rect width="${sw * 2}" height="${sh * 2}" rx="${26 * 2}" fill="#fff"/></svg>`
  );
  const rounded = await sharp(photo)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  layers.push({ ph, rounded });
}

// `embed`: the PNG carries the photos inline; og.svg (kept small, nothing links to it) points at the files.
const phones = embed =>
  layers
    .map(
      ({ ph, rounded }) =>
        `<g><rect x="${ph.x}" y="${ph.y}" width="${ph.w}" height="${ph.h}" rx="32" fill="#0D0E0F"/>` +
        `<image x="${ph.x + bezel}" y="${ph.y + bezel}" width="${ph.w - bezel * 2}" height="${ph.h - bezel * 2}" preserveAspectRatio="xMidYMid slice" clip-path="inset(0 round 26px)" href="${
          embed ? `data:image/png;base64,${rounded.toString('base64')}` : `looks/img/${ph.img}.webp`
        }"/>` +
        `<rect x="${ph.x + ph.w / 2 - 22}" y="${ph.y + 11}" width="44" height="6" rx="3" fill="#0D0E0F"/></g>`
    )
    .join('');

const build = embed => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<title>ebda ابدأ — ابدأ متجرك</title>
<rect width="${W}" height="${H}" fill="${CANVAS}"/>
<g filter="url(#sh)">${phones(embed)}</g>
<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#121314" flood-opacity=".22"/></filter></defs>
${lockup}
<g transform="translate(0 -62)"><path d="${pathOf('tagline')}" fill="${INK}"/></g>
<rect x="76" y="376" width="96" height="4" fill="${GOLD}"/>
<g transform="translate(0 -20)"><path d="${pathOf('url')}" fill="${MUTED}"/></g>
</svg>
`;
writeFileSync(path.join(dir, 'og.svg'), build(false));
await sharp(Buffer.from(build(true))).png({ compressionLevel: 9 }).toFile(path.join(dir, 'og.png'));
console.log('wrote og.svg og.png');
