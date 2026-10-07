// Writes public/demo/CREDITS.md from demo-photos.json: the openly licensed stock photos (CC0
// or CC BY, found via Openverse) used by the example stores. The photos reach the page only
// inside the real storefront captures (scripts/storefront-capture), so CREDITS is the one file
// shipped here. Re-run with `npm run demo-credits -w apps/marketing`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'demo');
mkdirSync(out, { recursive: true });
const photos = (await import(path.join(root, 'demo-photos.json'), { with: { type: 'json' } }))
  .default;
const rows = photos.map(
  p =>
    `| ${p.file} | [${p.title || 'photo'}](${p.page}) | ${p.creator ? (p.creatorUrl ? `[${p.creator}](${p.creatorUrl})` : p.creator) : 'unknown (public domain)'} | ${p.source} | [${p.license}](${p.licenseUrl}) |`
);
writeFileSync(
  path.join(out, 'CREDITS.md'),
  `# Demo store photo credits\n\nThe example stores on ebda.app are illustrations; no real shop or product is shown. Photos are openly licensed stock (found via Openverse), resized and cropped. CC BY photos require the attribution below.\n\n| File | Photo | Author | Source | License |\n|---|---|---|---|---|\n${rows.join('\n')}\n`
);
