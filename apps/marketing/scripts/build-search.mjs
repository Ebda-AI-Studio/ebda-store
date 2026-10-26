// Post-build: the live-search index of the marketing site (Arabic at /, English at /en/) plus the typeahead
// script, written into out/ by the same builder help and docs use (packages/site-kit). The 404 page loads the
// script and searches this index with help's and docs' (CORS-enabled) ones. Never indexes the 404 or legal-less junk.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSearchAssets } from '../../../packages/site-kit/src/build/search.mjs';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (['_next', 'assets', '3d', 'looks', 'demo', 'devices', 'logos'].includes(name)) continue;
      yield* htmlFiles(p);
    } else if (name === 'index.html') yield p;
  }
}

const strip = s =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const docs = [];
for (const file of htmlFiles(out)) {
  const html = readFileSync(file, 'utf8');
  if (/<meta name="robots" content="[^"]*noindex/.test(html)) continue;
  const rel = '/' + path.relative(out, path.dirname(file)).split(path.sep).join('/');
  const url = rel === '/' ? '/' : rel + '/';
  const lang = url === '/en/' || url.startsWith('/en/') ? 'en' : 'ar';
  const title = strip((html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '').split(' | ')[0];
  const main = (html.match(/<main[\s\S]*?<\/main>/) ?? [html])[0];
  const headings = [...main.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/g)].map(m => strip(m[1]));
  docs.push({
    url,
    title: title || headings[0] || url,
    section: lang === 'ar' ? 'ابدأ' : 'Ebda',
    lang,
    headings,
    html: main,
  });
}
await writeSearchAssets(out, docs);
console.log(`marketing search: ${docs.length} pages indexed`);
