// Parser shared by import-wa-legal.mjs and tests/unit/marketing-wa-legal-drift.test.ts.
import { readFileSync } from 'node:fs';

export const DOCS = [
  ['terms', 'waTerms'],
  ['privacy', 'waPrivacy'],
  ['dpa', 'waDpa'],
];
const OVERVIEW = { ar: 'نظرة عامة', en: 'Overview' };
/** A clause the source marks `<!-- PENDING LEGAL REVIEW: x -->` is published VISIBLY provisional, never as final (DOC-3). */
export const PROVISIONAL = {
  ar: '[مبدئي، قيد المراجعة القانونية]',
  en: '[Provisional, under legal review]',
};
export const PROVISIONAL_NOTE = {
  ar: 'البنود الموسومة «مبدئي، قيد المراجعة القانونية» لم يراجعها محامٍ بعد وقد تتغير.',
  en: 'Clauses marked "Provisional, under legal review" have not been reviewed by counsel yet and may change.',
};

function clean(t, lang) {
  return t
    .replace(/<!--\s*PENDING LEGAL REVIEW[\s\S]*?-->\s*/g, `${PROVISIONAL[lang]} `)
    .replace(/<!--[\s\S]*?-->\s*/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export function parse(file, lang) {
  const raw = readFileSync(file, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  const meta = Object.fromEntries(fm[1].split('\n').map(l => l.split(/:\s*/, 2)));
  const lines = raw.slice(fm[0].length).split('\n');
  let title = '';
  const sections = [];
  let cur = { h: OVERVIEW[lang], p: [] };
  let para = [];
  const flush = () => {
    if (para.length) cur.p.push(clean(para.join(' '), lang));
    para = [];
  };
  for (const line of lines) {
    if (line.startsWith('# ')) title = clean(line.slice(2), lang);
    else if (line.startsWith('## ')) {
      flush();
      if (cur.p.length) sections.push(cur);
      cur = { h: clean(line.slice(3), lang), p: [] };
    } else if (/^\|[\s|:-]+\|$/.test(line)) continue;
    else if (line.startsWith('|')) {
      flush();
      const cells = line
        .split('|')
        .slice(1, -1)
        .map(c => clean(c, lang));
      if (cells.length >= 3) cur.p.push(`${cells[0]}: ${cells[1]}. ${cells[2]}`);
      else cur.p.push(cells.join(': '));
    } else if (line.startsWith('- ')) {
      flush();
      cur.p.push('• ' + clean(line.slice(2), lang));
    } else if (line.trim() === '') flush();
    else if (/^Arabic version prevails\.|^النسخة العربية هي الحاكمة\.$/.test(line.trim())) continue;
    else para.push(line.trim());
  }
  flush();
  if (cur.p.length) sections.push(cur);
  const provisional = sections.reduce(
    (n, x) => n + x.p.filter(t => t.includes(PROVISIONAL[lang])).length,
    0
  );
  return { title, sections, updated: meta.updated, version: meta.version ?? '1.0', provisional };
}
