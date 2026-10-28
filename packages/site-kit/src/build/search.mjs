import MiniSearch from 'minisearch';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
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

/** Hard ceiling for one locale's serialized index, gzipped (what the browser downloads). */
export const MAX_INDEX_GZIP_BYTES = 150 * 1024;

/**
 * Build the static search assets into `outDir`: one serialized MiniSearch index PER LOCALE
 * (`search-index.<lang>.json`, so a page only downloads its own language), the search-page client
 * (`assets/search.js`) and the header typeahead (`assets/typeahead.js`). `docs` items:
 * { url, title, section, lang, headings: string[], html }. Fails the build if a locale's index is
 * over MAX_INDEX_GZIP_BYTES gzipped. Returns the measured sizes.
 */
export async function writeSearchAssets(outDir, docs) {
  mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  const sizes = {};
  for (const lang of [...new Set(docs.map(d => d.lang))]) {
    const mini = new MiniSearch(searchOptions);
    mini.addAll(
      docs
        .filter(d => d.lang === lang)
        .map(d => {
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
    const json = JSON.stringify(mini);
    const gz = gzipSync(json).length;
    if (gz > MAX_INDEX_GZIP_BYTES) {
      throw new Error(`search index ${lang} is ${gz} B gzipped, over the ${MAX_INDEX_GZIP_BYTES} B budget`);
    }
    writeFileSync(path.join(outDir, `search-index.${lang}.json`), json);
    sizes[lang] = { raw: json.length, gzip: gz };
  }
  for (const entry of ['search', 'typeahead']) {
    await build({
      entryPoints: [path.join(here, '..', 'client', `${entry}.js`)],
      bundle: true,
      minify: true,
      format: 'iife',
      target: 'es2019',
      outfile: path.join(outDir, 'assets', `${entry}.js`),
      logLevel: 'error',
    });
  }
  console.log('search index (gzip):', JSON.stringify(sizes));
  return sizes;
}
