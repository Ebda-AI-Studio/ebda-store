#!/usr/bin/env node
/**
 * Builds apps/api/src/cf/modules/pdf-lib.mjs (Ruling BUNDLE-BUDGET-7): @cantoo/pdf-lib bundled on its own so the API Worker
 * ships it as a separate ES module (wrangler `rules`) that is loaded on the first catalogue-import PDF, not as 460 KB of the
 * main script. The catalogue import's PDF step (`normalizePdf`) is the only caller. Colour conversion, HTML entities and the
 * HTML parser are stubbed exactly as the main bundle's aliases do (Ruling CATIMP-4).
 *   node scripts/ci/gen-pdf-lib-module.mjs          write
 *   node scripts/ci/gen-pdf-lib-module.mjs --check  exit 1 when the committed file was built from another pdf-lib version
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OUT_PATH = path.join(ROOT, 'apps/api/src/cf/modules/pdf-lib.mjs');
const require = createRequire(path.join(ROOT, 'apps/api/package.json'));
const version = () =>
  JSON.parse(readFileSync(path.join(ROOT, 'node_modules/@cantoo/pdf-lib/package.json'), 'utf8'))
    .version;
const banner = v =>
  `/* @cantoo/pdf-lib@${v} built as a separate Worker module by scripts/ci/gen-pdf-lib-module.mjs (Ruling BUNDLE-BUDGET-7). Do not edit. */\n`;

export async function renderPdfLibModule() {
  const { build } = await import('esbuild');
  const stub = path.join(ROOT, 'apps/api/src/cf/stubs/pdf-lib-unused.ts');
  const r = await build({
    entryPoints: [require.resolve('@cantoo/pdf-lib')],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'warning',
    alias: { culori: stub, 'html-entities': stub, 'node-html-better-parser': stub },
    mainFields: ['module', 'browser', 'main'],
  });
  return banner(version()) + Buffer.from(r.outputFiles[0].contents).toString('utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--check')) {
    const head = readFileSync(OUT_PATH, 'utf8').slice(0, banner(version()).length);
    if (head !== banner(version())) {
      console.error(
        `${OUT_PATH} was not built from @cantoo/pdf-lib@${version()}; run gen-pdf-lib-module.mjs`
      );
      process.exit(1);
    }
  } else {
    writeFileSync(OUT_PATH, await renderPdfLibModule());
  }
}
