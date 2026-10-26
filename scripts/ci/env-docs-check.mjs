#!/usr/bin/env node
// Read-only: reports env var NAMES read by the code that docs/ENVIRONMENT.md does not mention.
// Never prints values. Intentional omissions live in env-docs-allowlist.json (name -> reason).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  '.open-next',
  '.wrangler',
  '__tests__',
  'tests',
]);
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[a-z]+$|\.d\.ts$/;
// Framework / runtime names that are not ours to document.
const IGNORE = n =>
  n === 'NODE_ENV' ||
  n === 'CI' ||
  n === 'TZ' ||
  n === 'PORT' ||
  n === 'HOME' ||
  n === 'PATH' ||
  /^NEXT_/.test(n) ||
  /^npm_/.test(n);
const NAME = '[A-Z][A-Z0-9_]{2,}';
const PATTERNS = [
  new RegExp(`process\\.env\\.(${NAME})\\b`, 'g'),
  new RegExp(`process\\.env\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'),
  new RegExp(`(?<![\\w$.])(?:c\\.|ctx\\.|this\\.)?env\\.(${NAME})\\b`, 'g'),
  new RegExp(`\\benv\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'),
];

function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (SRC_EXT.test(e) && !TEST_FILE.test(e)) out.push(p);
  }
}

/** Returns Map<name, sorted list of repo-relative files that read it>. */
export function collectReadNames(root = ROOT) {
  const files = [];
  for (const group of ['apps', 'packages']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) walk(join(base, pkg, 'src'), files);
  }
  const names = new Map();
  const add = (n, f) => {
    if (IGNORE(n)) return;
    if (!names.has(n)) names.set(n, new Set());
    names.get(n).add(f);
  };
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of PATTERNS) for (const m of text.matchAll(re)) add(m[1], relative(root, f));
  }
  // wrangler vars / secret declarations
  const wr = [];
  for (const group of ['apps', 'packages', '.']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    const dirs = group === '.' ? [base] : readdirSync(base).map(d => join(base, d));
    for (const d of dirs) {
      if (!existsSync(d) || !statSync(d).isDirectory()) continue;
      for (const e of readdirSync(d)) if (/^wrangler.*\.jsonc?$/.test(e)) wr.push(join(d, e));
    }
  }
  for (const f of wr) {
    const text = readFileSync(f, 'utf8');
    const m = text.match(/"vars"\s*:\s*\{([^}]*)\}/g) || [];
    for (const block of m)
      for (const k of block.matchAll(new RegExp(`"(${NAME})"\\s*:`, 'g')))
        add(k[1], relative(root, f));
  }
  return names;
}

export function loadAllowlist(root = ROOT) {
  const p = join(root, 'scripts/ci/env-docs-allowlist.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return j.allow || {};
}

/** Names read by code, not allowlisted, and not mentioned (as a whole word) in docs/ENVIRONMENT.md. */
export function findMissing(root = ROOT) {
  const docs = readFileSync(join(root, 'docs/ENVIRONMENT.md'), 'utf8');
  const documented = new Set(docs.match(new RegExp(NAME, 'g')) || []);
  const allow = loadAllowlist(root);
  const read = collectReadNames(root);
  return [...read.entries()]
    .filter(([n]) => !documented.has(n) && !(n in allow))
    .map(([n, f]) => ({ name: n, files: [...f].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const missing = findMissing();
  for (const m of missing) console.log(`${m.name}\t${m.files.slice(0, 2).join(', ')}`);
  console.log(`${missing.length} env name(s) read by code but missing from docs/ENVIRONMENT.md`);
  process.exit(missing.length ? 1 : 0);
}
