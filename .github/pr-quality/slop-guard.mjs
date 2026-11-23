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
//   --merge-base-root DIR  (CI; built by merge-base-tree.sh) a data tree of the ratchet files as of merge-base(base, PR head) plus `.mb-touched`, the
//     files the PR changed since then. Rule for EVERY ratchet entry (slop id, eslint suppression entry, capability baseline id): the allowed value is the
//     base TIP's. The ONE exception: an entry the PR leaves unchanged (same key, its source file NOT in `.mb-touched`) may keep its merge-base value, so
//     a main that shrank after the PR branched does not fail it. Anything the PR touches is judged against the tip, so an OLD merge-base cannot
//     resurrect an exemption on code the PR edits. merge-base-tree.sh refuses (no `.mb-touched` written => plain tip comparison) when the merge-base is
//     more than 200 commits or 7 days behind the tip (MB_MAX_COMMITS / MB_MAX_DAYS).
// Config (.pr-quality.json): { "roots": ["apps","packages"], "locales": ["apps/web/messages"], "baseline": ".pr-quality-baseline.json",
//   "skip": ["generated"], "frameworkExports": ["extra names"], "ruleExemptions": [{ "rule": "unused-export", "path": "<foundation.lock.json dir>",
//   "reason": "...", "requires": "<foundation.lock.json parity test>" }] }.  Ruling SLOP-VENDORED-1: the ONLY exemption that exists. It waives the
//   `unused-export` rule (never another rule) for exactly the vendored foundation folder, and only while the lock proves every vendored file
//   byte-matches the tagged release and its parity test exists. Any wider path, another rule or a failed proof = the exemption is OFF and the
//   violations count again.   Inline escape on the same or previous line:  pq-allow(rule): reason
//   duplicate-helper has its own narrow escape (Ruling SLOP-TWIN-1): `// pq-allow(duplicate-helper): twin of <path>` above BOTH copies, each pointing at the
//   other; honoured only while the twin file exists, has the same function with an identical body, and points back.
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

// Ruling SLOP-TWIN-1: `// pq-allow(duplicate-helper): twin of <path>` on the line directly above a function (or on its line).
const TWIN = /pq-allow\(duplicate-helper\):\s*twin of\s+([^\s;,)]+)/;

/** every function declaration: name, normalised-body hash + length, line count, and its twin annotation (path) when it has one */
function allFunctions(text) {
  const out = [];
  const lines = text.split('\n');
  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/g;
  for (let m; (m = re.exec(text)); ) {
    const body = bodyAt(text, m.index + m[0].length);
    if (!body) continue;
    const n = normalise(body);
    const kw = m.index + m[0].indexOf('function');
    const line = text.slice(0, kw).split('\n').length - 1;
    const twin = TWIN.exec((lines[line - 1] ?? '') + '\n' + (lines[line] ?? ''))?.[1] ?? null;
    out.push({ name: m[1], hash: h(n), len: n.length, nlines: body.split('\n').length, twin });
  }
  return out;
}

function functions(text) {
  return allFunctions(text).filter((f) => f.len >= 160 && f.nlines >= 5 && !FRAMEWORK.has(f.name));
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

  // SLOP-TWIN-1: a deliberate byte-equal twin is accepted ONLY as a pair: (a) the named twin file exists, (b) it has the same
  // function with an identical body, (c) it carries the matching annotation pointing back. Anything else still fails.
  const all = new Map([...src].map(([f, t]) => [f, allFunctions(t)]));
  const twinOk = (f, fn) => {
    if (!fn.twin) return false;
    const other = (all.get(fn.twin) ?? []).find((y) => y.name === fn.name);
    return !!other && other.hash === fn.hash && other.twin === f;
  };
  for (const [f, fns] of all)
    for (const fn of fns)
      if (fn.twin && !twinOk(f, fn))
        viol.set(`duplicate-helper|${f}|${fn.name}|twin-invalid`, `${f} duplicate-helper  ${fn.name} claims "twin of ${fn.twin}" but that file is missing, has no identical ${fn.name}, or does not point back`);

  const groups = new Map();
  for (const [f, t] of src) for (const fn of functions(t)) groups.set(fn.hash, [...(groups.get(fn.hash) ?? []), { f, name: fn.name, fn }]);
  for (const [hash, g] of groups) {
    if (new Set(g.map((x) => x.f)).size < 2) continue;
    for (const x of g) {
      if (twinOk(x.f, x.fn)) continue;
      viol.set(`duplicate-helper|${x.f}|${x.name}|${hash}`, `${x.f} duplicate-helper  ${x.name} has the same body in ${g.filter((y) => y.f !== x.f).map((y) => y.f).join(', ')}`);
    }
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

  const waived = vendoredExemption(root, config);
  if (waived.dir) {
    for (const id of [...viol.keys()]) if (id.startsWith('unused-export|') && id.split('|')[1].startsWith(`${waived.dir}/`)) viol.delete(id);
  } else if ((config.ruleExemptions ?? []).length) {
    console.error(`slop-guard: the ruleExemptions entry is OFF (${waived.why}); the findings count`);
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

/** the merge-base reference tree, or null when it is absent (no `.mb-touched` = disabled = tip comparison) */
export function mergeBaseRef(dir) {
  if (!dir || !existsSync(join(dir, '.mb-touched'))) return null;
  const list = (f) => (existsSync(join(dir, f)) ? new Set(readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) : new Set());
  // `.mb-paths` = every path in the merge-base tree; a missing list means no id can name a real file (fail closed: tip comparison)
  return { dir, touched: list('.mb-touched'), paths: list('.mb-paths') };
}
/** the source file an id names (`rule|path|...`) ONLY when that path is a real file in the merge-base tree; otherwise null = no merge-base allowance
 *  (route ids like `/dashboard`, dotted names like `analytics.dashboard` and ids with no path are judged against the base tip alone) */
export const sourceOfId = (id, mb) => { const p = id.split('|')[1]; return p && mb.paths.has(p) ? p : null; };

/** per ENTRY (`suppressions-file`, source key, rule) counts over every eslint-suppressions.json under root */
export function eslintEntries(root, roots = ['apps', 'packages']) {
  const rootFile = join(root, 'eslint-suppressions.json');
  const names = [...(existsSync(rootFile) && lstatSync(rootFile).isFile() ? ['eslint-suppressions.json'] : []), ...walk(root, roots).filter((f) => f.endsWith('/eslint-suppressions.json'))];
  const entries = new Map();
  for (const f of names) {
    const data = readJsonRegular(join(root, f));
    for (const [src, rules] of Object.entries(data)) for (const [rule, v] of Object.entries(rules)) entries.set(JSON.stringify([f, src, rule]), { f, src, rule, n: v?.count ?? 0 });
  }
  return { entries, files: names.length };
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

/** entries whose count exceeds the allowed one: the base TIP's, or (untouched source file, merge-base reference `mb`) the larger of tip and merge-base.
 *  A base with no suppression files at all is the adoption PR: nothing to compare. Per ENTRY, never a per-file total: entries cannot be traded. */
export function eslintGrowth(root, baseRoot, roots, mb = null) {
  const base = eslintEntries(baseRoot, roots);
  if (base.files === 0) return [];
  const cur = eslintEntries(root, roots);
  const ref = mb ? eslintEntries(mb.dir, roots) : null;
  const out = [];
  for (const [k, e] of cur.entries) {
    const tip = base.entries.get(k)?.n ?? 0;
    let allowed = tip;
    if (ref && ref.files > 0) {
      const dir = e.f.includes('/') ? e.f.slice(0, e.f.lastIndexOf('/')) : '.';
      const paths = [e.src, dir === '.' ? e.src : `${dir}/${e.src}`];
      const real = paths.some((x) => mb.paths.has(x)); // the source must be a real file at the merge-base
      const touched = paths.some((x) => mb.touched.has(x));
      if (real && !touched) allowed = Math.max(tip, ref.entries.get(k)?.n ?? 0);
    }
    if (e.n > allowed) out.push(`${e.f}|${e.src}|${e.rule} ${tip} -> ${e.n}`);
  }
  return out;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
function* filesUnder(root, dir) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* filesUnder(root, rel);
    else yield rel;
  }
}

/**
 * Ruling SLOP-VENDORED-1. Returns the folder whose `unused-export` findings are waived, or { dir: null, why } when the exemption is not valid.
 * Valid only when: exactly one entry { rule: 'unused-export', path === foundation.lock.json "dir", reason, requires === the lock's parity test and it
 * exists }, AND every file the lock names under `dir` has the locked sha256, AND no file under `dir` is outside the lock.
 */
export function vendoredExemption(root, config = {}) {
  const entries = config.ruleExemptions ?? [];
  if (entries.length === 0) return { dir: null, why: 'none configured' };
  const lockPath = join(root, 'foundation.lock.json');
  if (!existsSync(lockPath)) return { dir: null, why: 'no foundation.lock.json' };
  let lock;
  try { lock = readJsonRegular(lockPath); } catch (e) { return { dir: null, why: String(e.message) }; }
  if (entries.length !== 1) return { dir: null, why: 'exactly one exemption is allowed' };
  const [x] = entries;
  if (x.rule !== 'unused-export') return { dir: null, why: `rule ${x.rule}: only unused-export may be exempted` };
  if (typeof x.reason !== 'string' || x.reason.trim().length < 10) return { dir: null, why: 'a real reason is required' };
  if (x.path !== lock.dir) return { dir: null, why: `path ${x.path} is not exactly the vendored folder ${lock.dir}` };
  if (x.requires !== lock.parity || !existsSync(join(root, x.requires))) return { dir: null, why: 'the parity test is missing' };
  for (const [rel, want] of Object.entries(lock.files ?? {})) {
    if (!rel.startsWith(`${lock.dir}/`) && rel !== lock.parity) continue;
    const p = join(root, rel);
    if (!existsSync(p) || lstatSync(p).isSymbolicLink() || sha256(readFileSync(p)) !== want) return { dir: null, why: `${rel} does not byte-match the lock` };
  }
  for (const f of filesUnder(root, lock.dir)) if (!(f in (lock.files ?? {}))) return { dir: null, why: `${f} is not in the lock` };
  return { dir: lock.dir, why: '' };
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
  // SLOP-VENDORED-1: ids the active exemption waives are ignored on BOTH sides (an old baseline entry for a waived vendored export is
  // neither "fixed but still listed" nor needed), so the exemption never forces every later PR to rewrite the baseline.
  const waivedDir = vendoredExemption(root, config).dir;
  const waivedId = (id) => !!waivedDir && id.startsWith('unused-export|') && id.split('|')[1].startsWith(`${waivedDir}/`);
  const rawBaseline = existsSync(basePath) ? readJsonRegular(basePath).ids ?? [] : null;
  const baseline = rawBaseline === null ? null : rawBaseline.filter((id) => !waivedId(id));
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
    const bpRel = config.baseline ?? '.pr-quality-baseline.json';
    const bp = join(baseRoot, bpRel);
    const mb = mergeBaseRef(arg('--merge-base-root', null));
    const mbp = mb && join(mb.dir, bpRel);
    const MB = new Set(mbp && existsSync(mbp) ? (readJsonRegular(mbp).ids ?? []).filter((id) => !waivedId(id)) : []);
    // an id absent from the TIP is allowed only when the PR left it unchanged since the merge-base (in it, source file untouched)
    const unchanged = (id) => { const src = mb && sourceOfId(id, mb); return MB.has(id) && !!src && !mb.touched.has(src); };
    if (existsSync(bp)) {
      const B = new Set((readJsonRegular(bp).ids ?? []).filter((id) => !waivedId(id)));
      for (const id of baseline ?? []) if (!B.has(id) && !unchanged(id)) { console.error(`slop-guard: the PR baseline holds an id the base branch's does not (it can only shrink): ${id}`); bad++; }
      for (const id of current.keys()) if (!B.has(id) && !unchanged(id)) { console.error(`slop-guard: NEW vs the base branch's baseline: ${current.get(id)}`); bad++; }
    }
    for (const g of eslintGrowth(root, baseRoot, config.roots, mb)) { console.error(`slop-guard: eslint suppressions grew vs the base branch (they can only shrink): ${g}`); bad++; }
  }
  if (bad) {
    if (added.length) console.error('Fix the new violation, or justify it inline with  pq-allow(<rule>): <reason>');
    process.exit(1);
  }
  console.log(`slop-guard: ok (${current.size} known violation(s), none new)`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
