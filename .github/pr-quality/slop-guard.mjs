#!/usr/bin/env node
// Mechanical slop guards with a baseline that can only shrink (os/standard/pr-quality.md).
//   rules: no-any | no-console | todo-no-issue | emoji-copy | duplicate-helper | unused-export
// Every violation gets a stable id (rule|file|content-hash, NOT a line number). The baseline is the set of ids that existed when
// the guard was adopted. A PR fails when it adds an id the baseline lacks, and ALSO when the baseline holds an id that no longer
// exists (a fixed violation must leave the baseline in the same PR, so its slot cannot be reused by a later regression).
//   node slop-guard.mjs [--root DIR] [--config FILE] [--baseline FILE] [--update] [--list]
//   --update  rewrite the baseline to the current set; REFUSES when that would add an id
//   --base-root DIR  (CI) DIR is a checkout of the BASE branch. The guard code runs from DIR, the PR is only scanned (--root). The ratchet is
//     then enforced against DIR's baseline, not the PR's copy: the PR baseline may not contain an id DIR's lacks, no violation outside DIR's
//     baseline is allowed, and none of the PR's eslint-suppressions.json may total more per rule than DIR's. DIR's .pr-quality.json also wins.
//     A DIR with no baseline yet (the adoption PR) falls back to the plain check.
// Config (.pr-quality.json): { "roots": ["apps","packages"], "locales": ["apps/web/messages"], "baseline": ".pr-quality-baseline.json",
//   "skip": ["generated"], "frameworkExports": ["extra names"] }.   Inline escape on the same or previous line:  pq-allow(rule): reason
import { readFileSync, readdirSync, lstatSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const RULES = ['no-any', 'no-console', 'todo-no-issue', 'emoji-copy', 'duplicate-helper', 'unused-export'];
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.open-next', '.wrangler', '.turbo', 'coverage', 'build', 'out', '.git', 'graphify-out']);
const FRAMEWORK = new Set(['metadata', 'generateMetadata', 'generateStaticParams', 'dynamic', 'dynamicParams', 'revalidate', 'runtime', 'config', 'viewport', 'generateViewport', 'fetchCache', 'preferredRegion', 'maxDuration', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'middleware', 'register']);
const isTest = (p) => /(?:^|\/)(?:__tests__|tests?|e2e|__mocks__|fixtures|scripts|loadtests|spikes)\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.d\.ts$|\.config\.[cm]?[jt]s$/.test(p);
const h = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);

/** JSON from a regular file inside the checkout; a symlink (possibly out of it) is refused, and a parse error never echoes file content */
export function readJsonRegular(path) {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink: refused`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${path} is not valid JSON`); }
}

export function walk(root, dirs, skip = []) {
  const out = [];
  const bad = new Set([...SKIP_DIRS, ...skip]);
  const rec = (d) => {
    for (const name of readdirSync(d)) {
      if (bad.has(name)) continue;
      const p = join(d, name);
      // lstat, never stat: a symlink in a PR checkout could point out of it (/etc, ~/.ssh) and the scanner would read it
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) rec(p);
      else if (st.isFile()) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  for (const d of dirs) {
    const top = join(root, d);
    if (existsSync(top) && !lstatSync(top).isSymbolicLink()) rec(top);
  }
  return out.sort();
}

const allowed = (lines, i, rule) => new RegExp(`pq-allow\\(${rule}\\):\\s*\\S`).test((lines[i - 1] ?? '') + '\n' + lines[i]);

function lineRules(file, text, add) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    const isComment = /^\s*(?:\/\/|\/?\*)/.test(line);
    if (!isComment && /(?::\s*any\b(?!\w)|\bas any\b|<any[>,]|\bany\[\])/.test(code) && !allowed(lines, i, 'no-any')) add('no-any', file, line.trim(), i + 1);
    if (!isComment && /\bconsole\.log\(/.test(code) && !allowed(lines, i, 'no-console')) add('no-console', file, line.trim(), i + 1);
    if (/(?:\/\/|\/\*|^\s*\*)[^\n]*\b(?:TODO|FIXME|XXX|HACK)\b/.test(line) && !/#\d+|\/issues\/\d+/.test(line) && !allowed(lines, i, 'todo-no-issue')) add('todo-no-issue', file, line.trim(), i + 1);
  });
}

function bodyAt(text, from) {
  const open = text.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}
const normalise = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();

function functions(text) {
  const out = [];
  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/g;
  for (let m; (m = re.exec(text)); ) {
    const body = bodyAt(text, m.index + m[0].length);
    if (!body) continue;
    const n = normalise(body);
    if (n.length >= 160 && body.split('\n').length >= 5 && !FRAMEWORK.has(m[1])) out.push({ name: m[1], hash: h(n) });
  }
  return out;
}

export function scan({ root, config = {} }) {
  const roots = config.roots ?? ['apps', 'packages', 'src'];
  const fw = new Set([...FRAMEWORK, ...(config.frameworkExports ?? [])]);
  const viol = new Map(); // id -> description
  const add = (rule, file, text, line) => viol.set(`${rule}|${file}|${h(text)}`, `${file}${line ? `:${line}` : ''} ${rule}  ${text.slice(0, 100)}`);
  const files = walk(root, roots, config.skip).filter((f) => CODE.test(f));
  const app = files.filter((f) => !isTest(f));
  const src = new Map(app.map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  for (const [f, t] of src) lineRules(f, t, add);

  const groups = new Map();
  for (const [f, t] of src) for (const fn of functions(t)) groups.set(fn.hash, [...(groups.get(fn.hash) ?? []), { f, name: fn.name }]);
  for (const [hash, g] of groups) {
    if (new Set(g.map((x) => x.f)).size < 2) continue;
    for (const x of g) viol.set(`duplicate-helper|${x.f}|${x.name}|${hash}`, `${x.f} duplicate-helper  ${x.name} has the same body in ${g.filter((y) => y.f !== x.f).map((y) => y.f).join(', ')}`);
  }

  const idents = new Map();
  for (const [f, t] of src) idents.set(f, new Set(t.match(/[A-Za-z_$][\w$]*/g) ?? []));
  const decl = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|class|abstract class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const [f, t] of src) {
    for (let m; (m = decl.exec(t)); ) {
      const name = m[1];
      if (fw.has(name)) continue;
      const line = t.slice(0, m.index).split('\n').length - 1;
      if (allowed(t.split('\n'), line, 'unused-export')) continue;
      let used = false;
      for (const [g, set] of idents) if (g !== f && set.has(name)) { used = true; break; }
      if (!used) viol.set(`unused-export|${f}|${name}`, `${f}:${line + 1} unused-export  ${name} is exported but nothing else imports it`);
    }
  }

  const EMOJI = /\p{Extended_Pictographic}/u;
  for (const d of config.locales ?? []) {
    for (const f of walk(root, [d], config.skip).filter((x) => x.endsWith('.json'))) {
      readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => {
        const bare = line.replace(/[\u00A9\u00AE\u2122\uFE0F]/g, '');
        if (EMOJI.test(bare)) add('emoji-copy', f, line.trim(), i + 1);
      });
    }
  }
  return viol;
}

/** sum of counts per `suppressions-file|rule` over every eslint-suppressions.json under root (a moved file keeps its total) */
export function eslintTotals(root, roots = ['apps', 'packages']) {
  const rootFile = join(root, 'eslint-suppressions.json');
  const names = [...(existsSync(rootFile) && lstatSync(rootFile).isFile() ? ['eslint-suppressions.json'] : []), ...walk(root, roots).filter((f) => f.endsWith('/eslint-suppressions.json'))];
  const totals = new Map();
  for (const f of names) {
    const data = readJsonRegular(join(root, f));
    for (const rules of Object.values(data)) for (const [rule, v] of Object.entries(rules)) totals.set(`${f}|${rule}`, (totals.get(`${f}|${rule}`) ?? 0) + (v?.count ?? 0));
  }
  return { totals, files: names.length };
}

/** `file|rule` keys whose total grew over the base's. A base with no suppression files at all is the adoption PR: nothing to compare. */
export function eslintGrowth(root, baseRoot, roots) {
  const base = eslintTotals(baseRoot, roots);
  if (base.files === 0) return [];
  const cur = eslintTotals(root, roots);
  return [...cur.totals].filter(([k, n]) => n > (base.totals.get(k) ?? 0)).map(([k, n]) => `${k} ${base.totals.get(k) ?? 0} -> ${n}`);
}

export function compare(current, baselineIds) {
  const base = new Set(baselineIds);
  return {
    added: [...current.keys()].filter((id) => !base.has(id)),
    stale: [...base].filter((id) => !current.has(id)),
  };
}

function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const root = arg('--root', process.cwd());
  const baseRoot = arg('--base-root', null);
  const readCfg = (dir) => (existsSync(join(dir, '.pr-quality.json')) ? readJsonRegular(join(dir, '.pr-quality.json')) : null);
  const cfgPath = arg('--config', join(root, '.pr-quality.json'));
  const config = (baseRoot && readCfg(baseRoot)) || (existsSync(cfgPath) ? readJsonRegular(cfgPath) : {});
  const basePath = arg('--baseline', join(root, config.baseline ?? '.pr-quality-baseline.json'));
  const current = scan({ root, config });
  if (a.includes('--list')) { for (const d of current.values()) console.log(d); console.log(`${current.size} violation(s)`); return; }
  const baseline = existsSync(basePath) ? readJsonRegular(basePath).ids ?? [] : null;
  if (baseline === null && !a.includes('--update')) { console.error(`slop-guard: no baseline at ${basePath}; create it once with --update --init`); process.exit(1); }
  const { added, stale } = compare(current, baseline ?? []);
  if (a.includes('--update')) {
    if (added.length && !(baseline === null && a.includes('--init'))) { console.error(`slop-guard: refusing to update: ${added.length} NEW violation(s) would enter the baseline (it can only shrink):`); for (const id of added) console.error(`  ${current.get(id)}`); process.exit(1); }
    writeFileSync(basePath, JSON.stringify({ note: 'ids of known violations; may only shrink (ci/pr-quality/slop-guard.mjs)', ids: [...current.keys()].sort() }, null, 1) + '\n');
    console.log(`slop-guard: baseline ${baseline === null ? 'created' : 'shrunk'}: ${current.size} id(s)`);
    return;
  }
  let bad = 0;
  for (const id of added) { console.error(`slop-guard: NEW ${current.get(id)}`); bad++; }
  for (const id of stale) { console.error(`slop-guard: FIXED but still in the baseline: ${id}  (run: node ${relative(root, process.argv[1])} --update)`); bad++; }
  if (baseRoot) {
    const bp = join(baseRoot, config.baseline ?? '.pr-quality-baseline.json');
    if (existsSync(bp)) {
      const B = new Set(readJsonRegular(bp).ids ?? []);
      for (const id of baseline ?? []) if (!B.has(id)) { console.error(`slop-guard: the PR baseline holds an id the base branch's does not (it can only shrink): ${id}`); bad++; }
      for (const id of current.keys()) if (!B.has(id)) { console.error(`slop-guard: NEW vs the base branch's baseline: ${current.get(id)}`); bad++; }
    }
    for (const g of eslintGrowth(root, baseRoot, config.roots)) { console.error(`slop-guard: eslint suppressions grew vs the base branch (they can only shrink): ${g}`); bad++; }
  }
  if (bad) {
    if (added.length) console.error('Fix the new violation, or justify it inline with  pq-allow(<rule>): <reason>');
    process.exit(1);
  }
  console.log(`slop-guard: ok (${current.size} known violation(s), none new)`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
