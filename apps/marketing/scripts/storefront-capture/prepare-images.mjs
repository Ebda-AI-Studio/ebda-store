// Capture input: the licensed demo photos (demo-photos.json) at storefront sizes, served to the
// local storefront on http://localhost:9000 (a host apps/web allows outside production).
//   node prepare-images.mjs <outDir>
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const photos = (
  await import(path.join(here, '..', '..', 'demo-photos.json'), { with: { type: 'json' } })
).default;
for (const p of photos) {
  const src = Buffer.from(
    await (await fetch(p.url, { headers: { 'User-Agent': 'ebda-marketing/1.0' } })).arrayBuffer()
  );
  const pos = p.position ?? sharp.strategy.attention;
  await sharp(src)
    .rotate()
    .resize(1000, 1000, { fit: 'cover', position: pos })
    .jpeg({ quality: 86 })
    .toFile(path.join(out, `${p.file}.jpg`));
  await sharp(src)
    .rotate()
    .resize(1800, 900, { fit: 'cover', position: pos })
    .jpeg({ quality: 84 })
    .toFile(path.join(out, `${p.file}-wide.jpg`));
  await sharp(src)
    .rotate()
    .resize(900, 1200, { fit: 'cover', position: pos })
    .jpeg({ quality: 84 })
    .toFile(path.join(out, `${p.file}-tall.jpg`));
  console.log('ok', p.file);
}
