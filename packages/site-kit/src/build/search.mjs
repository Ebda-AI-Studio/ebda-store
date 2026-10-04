import MiniSearch from 'minisearch';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchOptions } from '../search-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** HTML -> plain text for indexing / snippets. */
export function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the static search assets into `outDir`: `search-index.json` (a serialized MiniSearch
 * index) and `assets/search.js` (the bundled client). `docs` items:
 * { url, title, section, lang, headings: string[], html }.
 */
export async function writeSearchAssets(outDir, docs) {
  const mini = new MiniSearch(searchOptions);
  mini.addAll(
    docs.map(d => {
      const text = htmlToText(d.html);
      return {
        id: d.url,
        title: d.title,
        headings: d.headings.join(' '),
        text,
        section: d.section,
        lang: d.lang,
        snippet: text.slice(0, 160),
      };
    })
  );
  mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  writeFileSync(path.join(outDir, 'search-index.json'), JSON.stringify(mini));
  await build({
    entryPoints: [path.join(here, '..', 'client', 'search.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2019',
    outfile: path.join(outDir, 'assets', 'search.js'),
    logLevel: 'error',
  });
}
