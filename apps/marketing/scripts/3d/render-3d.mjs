// Renders the poster stills (transparent, 1200 px) for the new Jasmine and Dahab models.
//   node apps/marketing/scripts/3d/render-3d.mjs stills        (from the repo root; needs the Playwright Chromium)
// `openHarness` is also used by render-lantern.mjs.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const req = createRequire(path.join(root, 'noop.js'));
const { chromium } = req('@playwright/test');
const sharp = req('sharp');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };

export async function openHarness({ url, w, h, ...opts }) {
  const server = createServer(async (rq, rs) => {
    try {
      const p = path.join(root, decodeURIComponent(rq.url.split('?')[0]));
      if (!p.startsWith(root)) throw new Error('outside root');
      rs.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
      rs.end(await readFile(p));
    } catch { rs.writeHead(404); rs.end(); }
  }).listen(0);
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', e => console.error('page error', e.message));
  await page.goto(`http://localhost:${port}/apps/marketing/scripts/3d/render-harness.html`);
  await page.waitForFunction(() => window.ready);
  const info = await page.evaluate(o => window.setup(o), { url, w, h, ...opts });
  return { page, info, sharp, root, close: async () => { await browser.close(); server.close(); } };
}

if (process.argv[2] === 'stills') {
  const out = path.join(root, 'apps/marketing/public/3d/stills');
  await mkdir(out, { recursive: true });
  const jobs = [
    { file: 'jasmine-serum.glb', name: 'jasmine', variants: ['rose', 'amber', 'sage'], az: 0.5, el: 0.12, fit: 0.78 },
    { file: 'dahab-solitaire.glb', name: 'dahab', variants: ['yellow-gold', 'rose-gold', 'white-gold'], az: 0.55, el: 0.35, fit: 0.72 },
  ];
  for (const j of jobs) {
    const hx = await openHarness({ url: `/apps/marketing/public/3d/${j.file}`, w: 1200, h: 1200, exposure: 1.05 });
    for (const [i, v] of j.variants.entries()) {
      await hx.page.evaluate(a => window.draw(a), { az: j.az, el: j.el, fit: j.fit, variant: v });
      const png = await hx.page.locator('canvas').screenshot({ omitBackground: true });
      const base = i === 0 ? `${j.name}` : `${j.name}-${v}`;
      await hx.sharp(png).webp({ quality: 82, alphaQuality: 90 }).toFile(path.join(out, `${base}.webp`));
      await hx.sharp(png).resize(1200).avif({ quality: 55 }).toFile(path.join(out, `${base}.avif`));
      console.log('still', base);
    }
    await hx.close();
  }
}
