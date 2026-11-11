#!/usr/bin/env node
/**
 * Builds apps/api/src/cf/modules/exceljs.cjs (Ruling BUNDLE-BUDGET-6): the same exceljs library, bundled from its
 * `lib/exceljs.bare.js` source with the Node built-ins (`crypto`, `events`, `buffer`, `util`, `stream`) left to the Workers
 * `nodejs_compat` runtime instead of the browserify copies (bn.js, elliptic, asn1.js, hash.js, browserify-aes, a `buffer`
 * polyfill) that `dist/exceljs.bare.min.js` embeds: -390 KB of the API Worker. `fs`, `tmp`, `unzipper` and `archiver` (file
 * and stream readers the Worker never calls) are empty modules, exactly as exceljs' own browser build treats `fs`.
 *   node scripts/ci/gen-exceljs-workers.mjs          write
 *   node scripts/ci/gen-exceljs-workers.mjs --check  exit 1 when the committed file was built from another exceljs version
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OUT_PATH = path.join(ROOT, 'apps/api/src/cf/modules/exceljs.cjs');
const require = createRequire(import.meta.url);
const exceljsVersion = () => require('exceljs/package.json').version;
const banner = v =>
  `/* exceljs@${v} built for the API Worker by scripts/ci/gen-exceljs-workers.mjs (Ruling BUNDLE-BUDGET-6). Do not edit. */\n`;

export async function renderExceljsWorkers() {
  const { build } = await import('esbuild');
  const dir = mkdtempSync(path.join(tmpdir(), 'xl-'));
  const empty = path.join(dir, 'empty.cjs');
  writeFileSync(empty, 'module.exports = {};\n');
  const r = await build({
    entryPoints: [
      path.join(path.dirname(require.resolve('exceljs/package.json')), 'lib/exceljs.bare.js'),
    ],
    bundle: true,
    minify: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'warning',
    external: ['crypto', 'events', 'buffer', 'util', 'stream', 'zlib', 'process'],
    alias: { fs: empty, tmp: empty, unzipper: empty, archiver: empty },
    mainFields: ['browser', 'module', 'main'],
  });
  return banner(exceljsVersion()) + Buffer.from(r.outputFiles[0].contents).toString('utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--check')) {
    const head = readFileSync(OUT_PATH, 'utf8').slice(0, banner(exceljsVersion()).length);
    if (head !== banner(exceljsVersion())) {
      console.error(
        'exceljs-workers.cjs was built from another exceljs: run node scripts/ci/gen-exceljs-workers.mjs'
      );
      process.exit(1);
    }
  } else {
    const next = await renderExceljsWorkers();
    writeFileSync(OUT_PATH, next);
    console.log(`wrote ${OUT_PATH} (${next.length} B)`);
  }
}
