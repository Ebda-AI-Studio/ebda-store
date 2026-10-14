// Writes public/demo/CREDITS.md from demo-photos.json: the openly licensed stock photos (CC0
// or CC BY, found via Openverse) used by the example stores. The photos reach the page only
// inside the real storefront captures (scripts/storefront-capture), so CREDITS is the one file
// shipped here. The template looks (public/looks) use AI-generated illustrative photos instead. Re-run with `npm run demo-credits -w apps/marketing`.
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
  `# Demo store photo credits\n\nThe example stores on ebda.app are illustrations; no real shop or product is shown.\n\n## Template looks (public/looks)\n\nThe photos in the 15 template looks (Qamar, Souq, Jasmine, Lamma, Dahab) are illustrative and AI-generated with Cloudflare Workers AI FLUX.1 schnell (scripts/looks/gen.py, prompts in scripts/looks/prompts.py). They show no real shop, product or person and need no attribution.\n\n## 3D models (public/3d)\n\nBoth models are derivatives, optimised for the web with gltf-transform (meshopt compression, WebP textures up to 1024 px); the licences below require the attribution shown. The same credit appears next to the viewer on the home page.\n\n| File | Model | Author | Source | License | Changes |\n|---|---|---|---|---|---|\n| qamar-sneaker.glb | [MaterialsVariantsShoe](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/MaterialsVariantsShoe) (the sneaker, with its three colourways) | Shopify | Khronos glTF-Sample-Assets | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Optimised for the web (meshopt, WebP 1024 px); nothing else changed |\n| brass-diya-lantern.glb | [Brass Diya Lantern](https://polyhaven.com/a/brass_diya_lantern) | Bhargav Kubal | Poly Haven | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Hanging chain removed; optimised for the web (meshopt, WebP 1024 px). CC0 needs no attribution; it is given as a courtesy |\n\nThe stills in public/3d/stills are renders of these two models by scripts/3d/make-stills.mjs, so the same credit applies. public/3d/qr holds build-time QR codes (scripts/3d/make-qr.ts).\n\n## Dahab story capture\n\nThe remaining Dahab story capture uses openly licensed stock (found via Openverse), resized and cropped. CC BY photos require the attribution below.\n\n| File | Photo | Author | Source | License |\n|---|---|---|---|---|\n${rows.join('\n')}\n`
);
