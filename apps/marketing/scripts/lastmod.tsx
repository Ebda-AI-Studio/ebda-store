// Re-hashes the rendered markup of every dated page and bumps the lastmod date of the pages that changed.
//   npm run lastmod -w apps/marketing
import './no-css'; // first: the pages import stylesheets
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATED_PAGES, pageHash } from '../src/lib/page-markup';

const file = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'lib',
  'page-lastmod.json'
);
const prev: Record<string, { hash: string; date: string }> = (() => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
})();
const today = new Date().toISOString().slice(0, 10);
const next: typeof prev = {};
let changed = 0;
for (const page of DATED_PAGES) {
  const key = page || 'home';
  const hash = pageHash(page);
  next[key] = prev[key]?.hash === hash ? prev[key] : { hash, date: today };
  if (next[key] !== prev[key]) changed++;
}
writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
console.log(`lastmod: ${changed} page(s) re-dated to ${today}`);
