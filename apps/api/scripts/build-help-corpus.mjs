#!/usr/bin/env node
// Builds the two bundled assets of the assistant (the Worker cannot read the file system):
//   apps/api/src/smart-layer/registry.generated.json     the capability registry as the engine's RegistryCap list (the engine's own `toRegistryView`)
//   apps/api/src/smart-layer/help-corpus.generated.json  apps/help/content/{ar,en}/**/*.mdx as heading-aware chunks + a content hash (skip-if-unchanged index)
// `node apps/api/scripts/build-help-corpus.mjs` writes them (run it after changing `capabilities/` or `apps/help/content`; `tests/unit/assistant-adapter.test.ts` fails when they are stale); `--check` exits 1 when they are stale.
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
    corpus: `{"hash":${JSON.stringify(corpus.hash)},"docs":${lines('[', corpus.docs)}}\n`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { registry, corpus } = await buildAssets();
  const files = [
    ['registry.generated.json', registry],
    ['help-corpus.generated.json', corpus],
  ];
  if (process.argv.includes('--check')) {
    const stale = files
      .filter(([n, c]) => !existsSync(join(OUT, n)) || readFileSync(join(OUT, n), 'utf8') !== c)
      .map(([n]) => n);
    if (stale.length) {
      console.error(`stale: ${stale.join(', ')} (run node apps/api/scripts/build-help-corpus.mjs)`);
      process.exit(1);
    }
  } else for (const [n, c] of files) writeFileSync(join(OUT, n), c);
}
