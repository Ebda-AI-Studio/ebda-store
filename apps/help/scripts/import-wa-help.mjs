// Imports the Ebda Chat help guides (docs/help/{ar,en}/NN-slug.md in the ebda-whatsapp repo) read-only:
//   node apps/help/scripts/import-wa-help.mjs <path-to>/docs/help
// 1) vendors each source file verbatim into apps/help/wa-source/{ar,en}/ (sha256-pinned by
//    tests/unit/support-wa-help-drift.test.ts; prettier-ignored so the bytes stay identical);
// 2) writes content/{ar,en}/whatsapp/<slug>.mdx: title from the H1, description from the first paragraph,
//    guide-to-guide links rewritten to /whatsapp/<slug>/ (ar) or /en/whatsapp/<slug>/ (en).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SECTION = { ar: 'ابدأ شات', en: 'Ebda Chat' };
const q = s => `'${s.replace(/'/g, "''")}'`;
const desc = s => (s.length <= 162 ? s : s.slice(0, 161).trimEnd() + '…');
const clean = s => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');

/** Splits an optional leading front-matter block (capabilities, appPath) from the guide; the block is re-emitted by `convert`. */
export function splitFrontMatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  return m ? { fm: m[1], rest: raw.slice(m[0].length) } : { fm: '', rest: raw };
}

/**
 * Store registry entries (area `chat`) that document a Chat guide. The Chat source lists Chat's own ids; these Store
 * ids are appended to the published front matter so the Store help guard sees the entry linked to its article.
 */
export const STORE_LINKS = {
  'connect-your-own-number': ['chat.connect-number@1'],
  'use-the-shared-number': ['chat.ref-help@1'],
};

export function convert(raw, lang, order, slug = '') {
  const { fm: srcFm, rest } = splitFrontMatter(raw);
  const extraIds = STORE_LINKS[slug] ?? [];
  let fm = srcFm;
  if (extraIds.length) {
    const add = extraIds.map(i => `  - ${i}`).join('\n');
    fm = /^capabilities:/m.test(fm)
      ? fm
          .replace(/^(capabilities:\n(?:  - .*\n?)*)/m, m => m.replace(/\n?$/, '\n') + add + '\n')
          .trimEnd()
      : `${fm}\ncapabilities:\n${add}`.trim();
  }
  const lines = rest.split('\n');
  const h1 = lines.findIndex(l => l.startsWith('# '));
  const title = clean(lines[h1].slice(2).trim());
  const body = lines.slice(h1 + 1);
  while (body.length && body[0].trim() === '') body.shift();
  const para = [];
  for (const l of body) {
    if (l.trim() === '') break;
    para.push(l.trim());
  }
  const base = lang === 'ar' ? '' : '/en';
  const text = body
    .join('\n')
    .replace(
      /\((\d\d)-([a-z0-9-]+)\.md(#[^)]*)?\)/g,
      (_, _n, slug, h = '') => `(${base}/whatsapp/${slug}/${h})`
    );
  const extra = fm ? `\n${fm.trim()}` : '';
  return `---\ntitle: ${q(title)}\ndescription: ${q(desc(clean(para.join(' '))))}\nsection: ${q(SECTION[lang])}\norder: ${order}${extra}\n---\n\n${text.trimEnd()}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src) throw new Error('usage: import-wa-help.mjs <docs/help dir>');
  for (const lang of ['ar', 'en']) {
    const dir = path.join(src, lang);
    const srcOut = path.join(here, '..', 'wa-source', lang);
    const outDir = path.join(here, '..', 'content', lang, 'whatsapp');
    mkdirSync(srcOut, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    for (const f of readdirSync(dir).filter(f => /^\d\d-.*\.md$/.test(f))) {
      const [, n, slug] = /^(\d\d)-(.*)\.md$/.exec(f);
      copyFileSync(path.join(dir, f), path.join(srcOut, f));
      writeFileSync(
        path.join(outDir, `${slug}.mdx`),
        convert(readFileSync(path.join(dir, f), 'utf8'), lang, Number(n), slug)
      );
    }
  }
  console.log('written');
}
