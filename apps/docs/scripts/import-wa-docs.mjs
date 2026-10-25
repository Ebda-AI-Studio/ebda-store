// Imports the Ebda WhatsApp developer docs (docs/site/{ar,en}/whatsapp/*.mdx in the ebda-whatsapp repo) read-only:
//   node apps/docs/scripts/import-wa-docs.mjs <path-to>/docs/site
// 1) vendors each source file verbatim into apps/docs/wa-source/{ar,en}/ (prettier-ignored; sha256-pinned by
//    tests/unit/support-wa-docs-drift.test.ts);
// 2) writes content/whatsapp/{ar,en}/<slug>.mdx: the leading H1 is dropped (the page title is frontmatter), links to a
//    sibling page become /whatsapp/<slug>/ (en) or /ar/whatsapp/<slug>/ (ar), and an empty table header cell gets a
//    label (an empty <th> fails axe).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEAD0 = { ar: 'الخيار', en: 'Option' };

export function convert(raw, lang) {
  const prefix = lang === 'ar' ? '/ar' : '';
  let text = raw.replace(/^(---\n[\s\S]*?\n---\n\n?)# .*\n\n?/, '$1');
  text = text.replace(
    /\]\(\/whatsapp\/([a-z0-9-]+)(#[^)]*)?\)/g,
    (_, slug, h = '') => `](${prefix}/whatsapp/${slug}/${h})`
  );
  text = text.replace(/^\| \| /m, `| ${HEAD0[lang]} | `);
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src) throw new Error('usage: import-wa-docs.mjs <docs/site dir>');
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const lang of ['ar', 'en']) {
    const dir = path.join(src, lang, 'whatsapp');
    const vend = path.join(here, '..', 'wa-source', lang);
    const out = path.join(here, '..', 'content', 'whatsapp', lang);
    mkdirSync(vend, { recursive: true });
    mkdirSync(out, { recursive: true });
    for (const f of readdirSync(dir).filter(f => f.endsWith('.mdx'))) {
      copyFileSync(path.join(dir, f), path.join(vend, f));
      writeFileSync(path.join(out, f), convert(readFileSync(path.join(dir, f), 'utf8'), lang));
    }
  }
  console.log('written');
}
