#!/usr/bin/env node
// Builds the two bundled assets of the assistant (the Worker cannot read the file system):
//   apps/api/src/smart-layer/registry.generated.json     the capability registry as the engine's RegistryCap list (the engine's own `toRegistryView`)
//   apps/api/src/cf/modules/help-corpus.mjs             apps/help/content/{ar,en}/**/*.mdx as heading-aware chunks + a content hash (skip-if-unchanged index);
//                                                       an ES module the Worker uploads separately (wrangler `rules`), NOT part of worker.js (Ruling BUNDLE-BUDGET-12)
// BUILD-TIME ASSETS (docs/plans/2026-11-24-help-corpus-build-time.md): both files are git-ignored outputs, never committed. They are generated before every use:
// wrangler `build.command` (deploy, dry-run, dev), the npm-ci composite action (CI jobs), vitest globalSetup (unit + workers pools), and the pre-scripts of
// apps/api (dev/build/lint) and the root `typecheck`. `node apps/api/scripts/build-help-corpus.mjs` writes them; `--check` exits 1 when they are stale.
import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FDN = join(ROOT, 'packages/shared/src/foundation');
const OUT = join(ROOT, 'apps/api/src/smart-layer');

async function load() {
  const entry = `
    export { toRegistryView } from ${JSON.stringify(join(FDN, 'smart-layer/registry-view.ts'))};
    export { helpDoc, chunkHelp, corpusHash } from ${JSON.stringify(join(FDN, 'smart-layer/help.ts'))};
    export { capabilitySchema } from ${JSON.stringify(join(FDN, 'capability.ts'))};`;
  const r = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`
  );
}

const walk = dir =>
  readdirSync(dir)
    .sort()
    .flatMap(n =>
      statSync(join(dir, n)).isDirectory()
        ? walk(join(dir, n))
        : n.endsWith('.mdx')
          ? [join(dir, n)]
          : []
    );

export async function buildAssets() {
  const { toRegistryView, helpDoc, chunkHelp, corpusHash, capabilitySchema } = await load();
  const dir = join(ROOT, 'capabilities');
  const entries = readdirSync(dir)
    .filter(f => f.endsWith('.capability.json'))
    .sort()
    .map(f => capabilitySchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
  // uiLabels are derived from the titles when the registry is read (registry.ts), so they are not stored twice.
  const registry = [...toRegistryView(entries).caps.values()].map(
    ({ uiLabels: _derived, ...cap }) => cap
  );

  const docs = [];
  for (const lang of ['ar', 'en']) {
    const base = join(ROOT, 'apps/help/content', lang);
    if (!existsSync(base)) continue;
    for (const f of walk(base))
      docs.push(helpDoc(relative(base, f).replace(/\.mdx$/, ''), lang, readFileSync(f, 'utf8')));
  }
  const corpus = {
    hash: await corpusHash(docs),
    docs: docs.map(d => ({
      articleId: d.articleId,
      locale: d.locale,
      title: d.title,
      url: d.url,
      appPath: d.appPath,
      capabilityIds: d.capabilityIds,
      chunks: chunkHelp(d).map(c => c.text),
    })), // chunk id = `${articleId}:${locale}:${index}` (help-index.ts), so it is not stored
  };
  // One entry per line: a changed capability or guide is a one-line diff, never a rewrite of the whole file.
  const lines = (head, items) => `${head}\n${items.map(i => JSON.stringify(i)).join(',\n')}\n]`;
  return {
    registry: lines('[', registry) + '\n',
    corpus: `export default {"hash":${JSON.stringify(corpus.hash)},"docs":${lines('[', corpus.docs)}};\n`,
  };
}

/** Where each generated file goes (both are git-ignored build outputs: docs/plans/2026-11-24-help-corpus-build-time.md). */
export const targets = ({ registry, corpus }) => [
  ['registry.generated.json', registry],
  [join('..', 'cf', 'modules', 'help-corpus.mjs'), corpus],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const assets = await buildAssets();
  const files = targets(assets);
  if (process.argv.includes('--check')) {
    // CI sanity: the files on disk are exactly what the sources produce (a missing file counts as stale).
    const stale = files
      .filter(([n, c]) => !existsSync(join(OUT, n)) || readFileSync(join(OUT, n), 'utf8') !== c)
      .map(([n]) => n);
    if (stale.length) {
      console.error(`stale: ${stale.join(', ')} (run node apps/api/scripts/build-help-corpus.mjs)`);
      process.exit(1);
    }
  } else {
    // Write only what changed: a watcher (tsx watch, vitest watch) must not see a rewrite on every start.
    for (const [n, c] of files) {
      const f = join(OUT, n);
      if (!existsSync(f) || readFileSync(f, 'utf8') !== c) writeFileSync(f, c);
    }
  }
}
