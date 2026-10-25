// Parser shared by import-wa-legal.mjs and tests/unit/marketing-wa-legal-drift.test.ts.
import { readFileSync } from 'node:fs';

export const DOCS = [
  ['terms', 'waTerms'],
  ['privacy', 'waPrivacy'],
  ['dpa', 'waDpa'],
];
const OVERVIEW = { ar: 'نظرة عامة', en: 'Overview' };

function clean(t) {
  return t
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
    if (para.length) cur.p.push(clean(para.join(' ')));
    para = [];
  };
  for (const line of lines) {
    if (line.startsWith('# ')) title = clean(line.slice(2));
    else if (line.startsWith('## ')) {
      flush();
      if (cur.p.length) sections.push(cur);
      cur = { h: clean(line.slice(3)), p: [] };
    } else if (/^\|[\s|:-]+\|$/.test(line)) continue;
    else if (line.startsWith('|')) {
      flush();
      const cells = line.split('|').slice(1, -1).map(clean);
      if (cells.length >= 3) cur.p.push(`${cells[0]}: ${cells[1]}. ${cells[2]}`);
      else cur.p.push(cells.join(': '));
    } else if (line.startsWith('- ')) {
      flush();
      cur.p.push('• ' + clean(line.slice(2)));
    } else if (line.trim() === '') flush();
    else if (/^Arabic version prevails\.|^النسخة العربية هي الحاكمة\.$/.test(line.trim())) continue;
    else para.push(line.trim());
  }
  flush();
  if (cur.p.length) sections.push(cur);
  return { title, sections, updated: meta.updated };
}
