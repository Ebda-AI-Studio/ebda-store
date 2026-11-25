#!/usr/bin/env node
/**
 * pre-push-plan.mjs — what does the local pre-push gate need to run for THIS push? (Ruling PREPUSH-1)
 *
 * Reuses scripts/ci-affected.mjs (the same planner CI's pull_request lane uses). Output is one JSON object:
 *   mode      'full'     the planner cannot decide (lockfile / root config / shared core changed, or no merge base):
 *                        run the whole legacy gate. 'affected' = cheap checks + affected lint/typecheck + related tests.
 *                        'docs' = nothing but the cheap checks (formatting, gitleaks).
 *   lint      ['-w apps/x', ...]     workspaces to lint
 *   typecheck ['apps/x/tsconfig.json', ...]
 *   related   changed files to hand to `vitest related --run` (a changed test file runs itself; a changed source
 *             file runs every UNIT test that imports it)
 *   exclude   globs handed to `vitest related` as --exclude: integration / E2E never run locally (PREPUSH-2)
 *   files     all changed files (prettier is run on exactly these)
 *   scanners  (main() only) every repo-scanning unit test, always run whatever the mode (SCANNER_RULE below)
 *
 * Usage: node scripts/ci/pre-push-plan.mjs --base <sha>   |   --files a,b,c   (no git; tests)
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, loadWorkspaces } from '../ci-affected.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTABLE = /\.(ts|tsx|js|jsx|mjs|mts|cts)$/;

/**
 * PREPUSH-2: the local gate runs the UNIT tier only. `vitest related` follows imports, so a change to a shared file
 * (config, security, jobs) pulled in integration tests (refresh-token-rotation, auth-gdpr, warehouse/*) that need the
 * `test` role / test_db: 71 files failed on the environment, not on code. These globs are handed to vitest as
 * `--exclude`; integration and E2E stay in CI. The colocated `apps/api/src` tests are CI's integration job too (their
 * shared setup connects to Postgres + Redis), not part of the unit tier (`npm run test:unit`, ci.yml unit job).
 */
export const PREPUSH_EXCLUDE = [
  '**/tests/integration/**',
  '**/tests/e2e/**',
  '**/tests/smoke/**',
  '**/apps/api/src/**',
  '**/workers-test/**',
  '**/workers-do/**',
];

/**
 * SCANNER-1 (Ruling PREPUSH-3): the tests that read the SOURCE TREE rather than import one module. `vitest related` follows
 * imports, so a repo-wide gate (an `apps/admin` string scan, a route-table walk, a `git grep` for a banned pattern) is never
 * "related" to the file that broke it and only failed later in CI. Those tests ALWAYS run before a push.
 *
 * The rule is by content, not a list, so a new scanner is picked up the day it is written: a unit test (any depth under
 * tests/unit) whose source walks the tree (`readdirSync`, `globSync`, a `walk…(` helper, `git ls-files`) or greps it
 * (`git grep`). Fixture-only readers (`readFileSync` of one known file) are NOT scanners and are left to `related`.
 * A test that loads the WHOLE API router (`@api/routes`) and walks its table is a scanner too: its import is dynamic, so
 * `related` never reaches it from a changed `*.routes.ts`, and a wide push skips `related` anyway (PREPUSH-4). Missed:
 * route-table-manifest went red in CI on #811 and #887 for a new route (PREPUSH-7).
 */
export const SCANNER_RULE =
  /\b(readdirSync|globSync)\b|\bwalk\w*\(|git[ '",]+(ls-files|grep)\b|['"`]ls-files['"`]|['"`]grep['"`]|['"`]@api\/routes['"`]/;

export function scannerTests(root = ROOT, rel = 'tests/unit') {
  const out = [];
  const visit = dir => {
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) visit(p);
      else if (
        /\.test\.(ts|tsx|mjs|js)$/.test(e.name) &&
        SCANNER_RULE.test(readFileSync(path.join(root, p), 'utf8'))
      )
        out.push(p);
    }
  };
  visit(rel);
  return out.sort();
}

/**
 * PREPUSH-6 (change class): a push that touches ONLY docs, workflows, i18n/locale JSON or tests cannot change what a source
 * scanner reads in apps/*, so the 200+ repo-scanning tests are narrowed to those that could notice it: a scanner stays when it
 * is tree-wide (git ls-files / git grep), when its source names a changed top-level directory or file, or when it is itself
 * changed. Any other changed file (source, config, lockfile, scripts) keeps the full scanner list. CI runs every scanner.
 */
export const LIGHT_CLASS = /^(docs\/|\.github\/|.*\.md$|.*\/(locales|i18n|messages)\/[^/]+\.json$|tests\/|.*\.test\.[a-z]+$)/;
const TREE_WIDE = /git[ '",]+(ls-files|grep)\b|['"`]ls-files['"`]|['"`]grep['"`]/;

export function isLightPush(files) {
  const f = files.filter(Boolean);
  return f.length > 0 && f.every(x => LIGHT_CLASS.test(x));
}

export function narrowScanners(scanners, files, root = ROOT) {
  const f = files.filter(Boolean);
  if (!isLightPush(f)) return scanners;
  const needles = new Set();
  for (const x of f) {
    needles.add(x);
    if (/^tests\//.test(x) || /\.test\.[a-z]+$/.test(x)) continue; // a test file matters only to a scanner that names it
    needles.add(path.dirname(x));
    needles.add(x.split('/')[0]);
    if (/\.md$/.test(x)) needles.add('.md');
  }
  needles.delete('.');
  return scanners.filter(t => {
    if (f.includes(t)) return true;
    const src = readFileSync(path.join(root, t), 'utf8');
    if (TREE_WIDE.test(src)) return true;
    for (const n of needles) if (src.includes(n)) return true;
    return false;
  });
}

export function plan(files, workspaces) {
  const changed = files.filter(Boolean);
  const r = classify(changed, workspaces);
  if (!r.code) return { mode: 'docs', lint: [], typecheck: [], related: [], files: changed };
  // `all` = lockfile, package.json, tsconfig/vitest/eslint config, packages/shared, packages/database, any root file:
  // the blast radius is the whole repo, so we do not guess.
  if (r.all) return { mode: 'full', lint: [], typecheck: [], related: [], files: changed };
  return {
    mode: 'affected',
    lint: r.lint,
    typecheck: r.typecheck,
    related: r.changedFiles.filter(f => TESTABLE.test(f)),
    exclude: PREPUSH_EXCLUDE,
    files: changed,
  };
}

function main(argv) {
  const arg = n => {
    const i = argv.indexOf(`--${n}`);
    return i > -1 ? argv[i + 1] : undefined;
  };
  let files;
  if (arg('files') !== undefined) files = arg('files').split(',');
  else {
    const base = arg('base');
    if (!base)
      return console.log(
        JSON.stringify({
          mode: 'full',
          lint: [],
          typecheck: [],
          related: [],
          files: [],
          scanners: scannerTests(),
        })
      );
    files = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
  }
  const p = plan(files, loadWorkspaces());
  const light = isLightPush(files);
  // lightRelated: every related file is itself a test, few of them: runs in a light slot, never under the heavy lock
  const lightRelated = light && (p.related || []).length > 0 && (p.related || []).every(f => /(^tests\/|\.test\.)/.test(f));
  console.log(
    JSON.stringify({ ...p, light, lightRelated, scanners: narrowScanners(scannerTests(), files) })
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
