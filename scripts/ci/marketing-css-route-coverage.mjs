#!/usr/bin/env node
// Marketing per-route CSS coverage (Ruling CSS-BUDGET-726-1): the CSS is split per route (globals.css = shared base,
// route-*.css = one route each, imported only by that route's components). A split is only safe if every page still
// loads EVERY rule that matches its markup. This reads the static export and fails when a page's HTML uses classes/ids
// that a rule in some OTHER (unloaded) stylesheet targets and no stylesheet the page does load carries that rule.
//   node scripts/ci/marketing-css-route-coverage.mjs [--out apps/marketing/out]
// Two checks per page: (1) every class in its HTML that the SOURCE css files define must appear in a stylesheet the page
// loads (catches a dropped route import, where the rule is not in the export at all); (2) no rule its markup matches may
// sit only in a stylesheet it does not load.
// Static HTML only: a rule whose class never appears in any page (toggled by script, e.g. `.open`) is left to the base.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(
  args.includes('--out') ? args[args.indexOf('--out') + 1] : 'apps/marketing/out'
);

/** Top-level blocks of a (minified) stylesheet; quotes and parens are respected. */
export function blocks(css) {
  const out = [];
  let depth = 0;
  let start = 0;
  let q = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        out.push(css.slice(start, i + 1));
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) start = i + 1;
  }
  return out;
}

/** Leaf rules as `context|selectors|body` strings (at-rule blocks are walked, their prelude is the context). */
export function leafRules(css, ctx = '') {
  const out = [];
  for (const b of blocks(css)) {
    const head = b.slice(0, b.indexOf('{')).trim();
    const inner = b.slice(b.indexOf('{') + 1, b.lastIndexOf('}'));
    if (/^@(media|supports|container|layer)/.test(head))
      out.push(...leafRules(inner, `${ctx}${head}>`));
    else if (!head.startsWith('@')) out.push({ key: `${ctx}${b}`, sel: head });
  }
  return out;
}

const classesOf = sel =>
  [...sel.replace(/\\./g, '').matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m => m[1]);
const idsOf = sel => [...sel.matchAll(/#([A-Za-z_][\w-]*)/g)].map(m => m[1]);

const dirs = (d, o = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === '_next' || e.name.startsWith('__next')) continue;
      dirs(p, o);
    } else if (e.name === 'index.html') o.push(p);
  }
  return o;
};

const cssDir = path.join(root, '_next/static');
const all = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.css')) all.push(p);
  }
})(cssDir);
const rulesByFile = new Map(all.map(f => [f, leafRules(readFileSync(f, 'utf8'))]));

const pages = dirs(root).map(f => {
  const html = readFileSync(f, 'utf8');
  const cls = new Set();
  for (const m of html.matchAll(/\bclass="([^"]*)"/g))
    m[1].split(/\s+/).forEach(c => c && cls.add(c));
  const ids = new Set([...html.matchAll(/\bid="([^"]*)"/g)].map(m => m[1]));
  const sheets = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(m =>
    path.join(root, m[1].split('?')[0])
  );
  return { page: '/' + path.relative(root, path.dirname(f)).replace(/\\/g, '/'), cls, ids, sheets };
});
const knownCls = new Set(pages.flatMap(p => [...p.cls]));
const knownIds = new Set(pages.flatMap(p => [...p.ids]));

const matches = (sel, p) =>
  sel.split(',').some(s => {
    const c = classesOf(s);
    const i = idsOf(s);
    if (!c.length && !i.length) return false; // not class/id scoped: the base
    // a class that is in NO page's HTML (script-toggled, or another build mode's pages) cannot be proven present here
    if (c.some(x => !knownCls.has(x)) || i.some(x => !knownIds.has(x))) return false;
    return c.every(x => p.cls.has(x)) && i.every(x => p.ids.has(x));
  });

// classes the source stylesheets define (comments stripped); services.css is excluded: those pages are not in every build mode
const srcDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../apps/marketing/src/app'
);
const defined = new Set();
for (const f of readdirSync(srcDir).filter(n => n.endsWith('.css') && n !== 'services.css'))
  for (const c of classesOf(
    readFileSync(path.join(srcDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  ))
    defined.add(c);

let bad = 0;
for (const p of pages) {
  const text = p.sheets.map(f => readFileSync(f, 'utf8')).join('\n');
  const absent = [...p.cls].filter(
    c => defined.has(c) && !new RegExp(`\\.${c}(?![\\w-])`).test(text)
  );
  if (absent.length) {
    bad++;
    console.log(
      `MISSING ${p.page}: class(es) in its HTML defined by marketing CSS but in no stylesheet it loads: ${absent.slice(0, 6).join(', ')}`
    );
  }
}
for (const p of pages) {
  const loaded = new Set(p.sheets.flatMap(f => (rulesByFile.get(f) ?? []).map(r => r.key)));
  const missing = [];
  for (const [f, rules] of rulesByFile) {
    if (p.sheets.includes(f)) continue;
    for (const r of rules)
      if (!loaded.has(r.key) && matches(r.sel, p))
        missing.push(r.sel.replace(/\s+/g, ' ').slice(0, 60));
  }
  if (missing.length) {
    bad++;
    console.log(
      `MISSING ${p.page}: ${missing.length} rule(s) its markup matches are in an unloaded stylesheet, e.g. ${[...new Set(missing)].slice(0, 4).join(' | ')}`
    );
  }
}
console.log(
  bad
    ? `marketing CSS route coverage FAILED (${bad} page(s))`
    : `marketing CSS route coverage OK (${pages.length} pages)`
);
process.exit(bad ? 1 : 0);
