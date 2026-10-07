// Downloads the demo-store photos listed in demo-photos.json (openly licensed stock found via
// the Openverse API: CC0 or CC BY), square-crops them on the subject and writes
// public/demo/<file>-<size>.{avif,webp} plus public/demo/CREDITS.md.
// Re-run with `npm run demo-photos -w apps/marketing`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'demo');
mkdirSync(out, { recursive: true });
const photos = (await import(path.join(root, 'demo-photos.json'), { with: { type: 'json' } }))
  .default;
export const SIZES = [240, 480];

for (const p of photos) {
  const res = await fetch(p.url, { headers: { 'User-Agent': 'ebda-marketing/1.0 (+https://ebda.app)' } });
  if (!res.ok) throw new Error(`${p.file}: HTTP ${res.status} for ${p.url}`);
  const src = Buffer.from(await res.arrayBuffer());
  for (const size of SIZES) {
    const base = sharp(src).rotate().resize(size, size, { fit: 'cover', position: p.position ?? sharp.strategy.attention });
    await base.clone().avif({ quality: 52, effort: 6 }).toFile(path.join(out, `${p.file}-${size}.avif`));
    await base.clone().webp({ quality: 74 }).toFile(path.join(out, `${p.file}-${size}.webp`));
  }
  console.log('ok', p.file);
}

const rows = photos.map(
  p =>
    `| ${p.file} | [${p.title || 'photo'}](${p.page}) | ${p.creator ? (p.creatorUrl ? `[${p.creator}](${p.creatorUrl})` : p.creator) : 'unknown (public domain)'} | ${p.source} | [${p.license}](${p.licenseUrl}) |`
);
writeFileSync(
  path.join(out, 'CREDITS.md'),
  `# Demo store photo credits\n\nThe example stores on ebda.app are illustrations; no real shop or product is shown. Photos are openly licensed stock (found via Openverse), resized and cropped. CC BY photos require the attribution below.\n\n| File | Photo | Author | Source | License |\n|---|---|---|---|---|\n${rows.join('\n')}\n`
);
