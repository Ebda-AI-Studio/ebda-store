#!/usr/bin/env node
/**
 * ci-affected.mjs — which workspaces does a PR touch? (lean CI, SP4 task 9)
 *
 * The pull_request lane of .github/workflows/ci.yml runs only lint, typecheck
 * and unit tests for the workspaces a PR changed (plus their dependents), so
 * a typical PR stays well inside the 2,000 free GitHub-hosted minutes/month.
 *
 * Usage:  node scripts/ci-affected.mjs --base <sha> [--head <ref>]
 *         node scripts/ci-affected.mjs --files a.ts,b.ts       (no git; for tests)
 * Output: key=value lines on stdout, and appended to $GITHUB_OUTPUT when set.
 *
 * Rules (first match wins), per changed file:
 *   docs-only  docs/**, *.md, .github/ISSUE_TEMPLATE/**, .vscode/**, .editorconfig
 *              -> ignored (a docs-only PR runs only the always-on jobs)
 *   workspace  apps/<n>/** or packages/<n>/** -> that workspace, plus every
 *              workspace that depends on it (transitively, from package.json)
 *   all        packages/shared/**, packages/database/** or any other root file
 *              (package.json, lockfile, tsconfig*, eslint/vitest config, ...)
 *              -> every workspace
 *   infra      .github/**, scripts/** -> unit tests only (they pin workflows
 *              and scripts); no per-workspace lint/typecheck
 *   tests      tests/** -> unit tests only
 *
 * The Worker dry-run (`workers`) is narrower than "affected": it costs ~9
 * billed minutes per Next app (OpenNext build), so it runs only when something
 * that can move the Worker bundle or its start-up changed: the app's own
 * package.json / wrangler / next / open-next config (and its Worker entry), or
 * the root manifest/lockfile and the cf-* scripts (which hit every Worker app).
 * Ordinary source changes are covered by lint/typecheck/unit; the deploy path
 * dry-runs the Worker itself.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Workspaces that are Cloudflare Workers; deployed with wrangler. */
export const WORKER_APPS = [
  'apps/api',
  'apps/web',
  'apps/admin',
  'apps/orders',
  'apps/marketing',
  'apps/status',
  'apps/accounts',
];

/** Changing these affects every workspace. */
export const GLOBAL_WORKSPACES = ['packages/shared', 'packages/database'];

/** vitest paths per workspace for the PR unit lane. */
export const UNIT_PATHS = {
  'packages/shared': ['packages/shared/src'],
  'packages/database': ['packages/database/src'],
  'packages/cf-schema': ['packages/cf-schema'],
  'apps/web': ['apps/web'],
  'apps/admin': ['apps/admin/src'],
  'apps/orders': ['apps/orders'],
};
/**
 * The search eval harness (tests/search-eval) imports API internals, so it is typechecked whenever
 * it or the API changes (a signature change must fail CI, not the next manual eval run).
 */
export const SEARCH_EVAL_TSCONFIG = 'tests/search-eval/tsconfig.json';

/** Always part of the unit lane when any code changed: cross-app source pins. */
export const BASE_UNIT_PATHS = ['tests/unit'];

/** Per-app files that can move the Worker bundle (beyond package.json + configs). */
const WORKER_ENTRY = {
  'apps/web': /^apps\/web\/sentry-worker-entry\.ts$/,
  'apps/status': /^apps\/status\/src\//,
  'apps/accounts': /^apps\/accounts\/src\//,
  'apps/api': /^apps\/api\//,
};
const WORKER_CONFIG = dir =>
  new RegExp(
    `^${dir}/(package\\.json|wrangler\\.(jsonc|json|toml)|open-next\\.config\\.ts|next\\.config\\.[cm]?[jt]s)$`
  );
/** Root files that hit every Worker app. */
const WORKER_ROOT =
  /^(package\.json|package-lock\.json|scripts\/(cf-build\.sh|cf-setup-local\.sh|assert-cf-cache-bindings\.sh))$/;

const DOCS_ONLY = /^(docs\/|.*\.md$|\.github\/ISSUE_TEMPLATE\/|\.vscode\/|\.editorconfig$)/;

export function loadWorkspaces(root = ROOT) {
  const out = [];
  for (const group of ['apps', 'packages']) {
    const base = path.join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pj = path.join(base, name, 'package.json');
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      const deps = Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      });
      out.push({
        dir: `${group}/${name}`,
        name: pkg.name,
        deps,
        hasLint: Boolean(pkg.scripts?.lint),
        hasTsconfig: existsSync(path.join(base, name, 'tsconfig.json')),
        hasWrangler: ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some(f =>
          existsSync(path.join(base, name, f))
        ),
      });
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function classify(files, workspaces) {
  const byDir = new Map(workspaces.map(w => [w.dir, w]));
  const direct = new Set();
  let all = false;
  let infra = false;
  let tests = false;
  let code = false;
  let searchEval = false;
  const codeFiles = [];

  for (const f of files.filter(Boolean)) {
    if (DOCS_ONLY.test(f)) continue;
    code = true;
    codeFiles.push(f);
    const m = /^(apps|packages)\/([^/]+)\//.exec(f);
    if (m && byDir.has(`${m[1]}/${m[2]}`)) {
      direct.add(`${m[1]}/${m[2]}`);
    } else if (f.startsWith('tests/')) {
      tests = true;
      if (f.startsWith('tests/search-eval/')) searchEval = true;
    } else if (f.startsWith('.github/') || f.startsWith('scripts/')) {
      infra = true;
    } else {
      all = true;
    }
  }
  if ([...direct].some(d => GLOBAL_WORKSPACES.includes(d))) all = true;

  const affected = new Set(all ? workspaces.map(w => w.dir) : direct);
  // Transitive dependents (a change in packages/ui affects whoever imports it).
  let grew = !all;
  while (grew) {
    grew = false;
    for (const w of workspaces) {
      if (affected.has(w.dir)) continue;
      const needs = workspaces.filter(x => affected.has(x.dir)).map(x => x.name);
      if (w.deps.some(d => needs.includes(d))) {
        affected.add(w.dir);
        grew = true;
      }
    }
  }
  const ws = workspaces.filter(w => affected.has(w.dir));

  const runAllUnit = all || tests || infra;
  const workerTouched = new Set();
  for (const f of codeFiles) {
    if (WORKER_ROOT.test(f)) WORKER_APPS.forEach(d => workerTouched.add(d));
    for (const d of WORKER_APPS) {
      if (WORKER_CONFIG(d).test(f) || WORKER_ENTRY[d]?.test(f)) workerTouched.add(d);
    }
  }

  const unit = new Set();
  if (code) BASE_UNIT_PATHS.forEach(p => unit.add(p));
  for (const w of ws) (UNIT_PATHS[w.dir] ?? []).forEach(p => unit.add(p));
  if (runAllUnit)
    Object.values(UNIT_PATHS)
      .flat()
      .forEach(p => unit.add(p));

  return {
    code,
    all,
    workspaces: ws.map(w => w.dir),
    lint: ws.filter(w => w.hasLint).map(w => `-w ${w.dir}`),
    typecheck: [
      ...ws.filter(w => w.hasTsconfig).map(w => `${w.dir}/tsconfig.json`),
      ...(searchEval || affected.has('apps/api') ? [SEARCH_EVAL_TSCONFIG] : []),
    ],
    unit: [...unit],
    // status runs on workerd, outside the root vitest config (npm run test:status)
    statusTests: all || direct.has('apps/status'),
    accountsTests: all || direct.has('apps/accounts'),
    workers: ws.filter(w => workerTouched.has(w.dir) && w.hasWrangler).map(w => w.dir.slice(5)),
    changedFiles: codeFiles,
  };
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function formatOutputs(r) {
  const lines = {
    code: String(r.code),
    all: String(r.all),
    lint: r.lint.join(' '),
    typecheck: r.typecheck.join(' '),
    unit: r.unit.join(' '),
    status_tests: String(r.statusTests),
    accounts_tests: String(r.accountsTests),
    workers: JSON.stringify(r.workers),
    has_workers: String(r.workers.length > 0),
    affected: r.workspaces.join(' '),
  };
  return Object.entries(lines).map(([k, v]) => `${k}=${v}`);
}

function main(argv) {
  const arg = n => {
    const i = argv.indexOf(`--${n}`);
    return i > -1 ? argv[i + 1] : undefined;
  };
  let files;
  if (arg('files') !== undefined) {
    files = arg('files').split(',');
  } else {
    const base = arg('base');
    if (!base) {
      // No base (push / schedule / dispatch): everything is in scope.
      files = ['package.json'];
    } else {
      // Two-dot against the PR base, as the merge-commit checkout holds both.
      files = git('diff', '--name-only', base, arg('head') ?? 'HEAD').split('\n');
    }
  }
  const lines = formatOutputs(classify(files, loadWorkspaces()));
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
