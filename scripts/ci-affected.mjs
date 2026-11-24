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
 * Integration tier (2026-10-25, #227): the Postgres integration tests (tests/integration) are NOT part of the PR lane
 * by default, and #227 merged four edited integration test files that never ran. `integrationPlan()` decides when a PR
 * must run them: a changed tests/integration/*.test.ts runs exactly that file; a changed source file that an
 * integration test imports (the services/routes/middleware those tests cover) runs the tests that import it; a changed
 * shared test helper/fixture or anything under packages/database runs them all. Output: `integration` (bool) and
 * `integration_paths` (`all` or a space list of test files).
 *
 * The Worker dry-run (`workers`) is narrower than "affected": it costs ~9
 * billed minutes per Next app (OpenNext build), so it runs only when something
 * that can move the Worker bundle or its start-up changed: the app's own
 * package.json / wrangler / next / open-next config (and its Worker entry), or
 * the root manifest/lockfile and the cf-* scripts (which hit every Worker app).
 * Ordinary source changes are covered by lint/typecheck/unit; the deploy path
 * dry-runs the Worker itself.
 * Exception: apps/marketing (a static export, no OpenNext build) dry-runs on any
 * change to its src/public/scripts or the page-weight budget, so its budget gate
 * runs on the PR that moves it.
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

/**
 * Apps whose PRODUCTION BUILD is a deploy step (cf-<app>-deploy.yml). OPS-2: #248 merged green and broke the storefront
 * build because PR checks never built the apps. The PR lane builds every one of these whose dependency graph includes a
 * changed workspace (packages/ui or packages/shared touch all of them).
 */
export const BUILD_APPS = [
  'apps/web',
  'apps/admin',
  'apps/orders',
  'apps/marketing',
  'apps/docs',
  'apps/help',
];

/** Changing these affects every workspace. */
export const GLOBAL_WORKSPACES = ['packages/shared', 'packages/database'];

/** vitest paths per workspace for the PR unit lane. */
export const UNIT_PATHS = {
  'packages/shared': ['packages/shared/src'],
  'packages/database': ['packages/database/src'],
  'packages/cf-schema': ['packages/cf-schema'],
  'packages/cf-migrate': ['packages/cf-migrate'],
  'packages/repo': ['packages/repo'],
  'apps/web': ['apps/web'],
  'apps/admin': ['apps/admin/src'],
  'apps/orders': ['apps/orders'],
};
/**
 * The search eval harness (tests/search-eval) imports API internals, so it is typechecked whenever
 * it or the API changes (a signature change must fail CI, not the next manual eval run).
 */
export const SEARCH_EVAL_TSCONFIG = 'tests/search-eval/tsconfig.json';

/** Files the generated CF schema is derived from (prisma schema + raw SQL migrations). */
const PRISMA_INPUT = /^packages\/database\/prisma\/(schema\.prisma|migrations\/)/;

/** Always part of the unit lane when any code changed: cross-app source pins. */
export const BASE_UNIT_PATHS = ['tests/unit'];

/**
 * Per-app files that can move the Worker bundle (beyond package.json + configs).
 * apps/web: the custom Worker entry AND every local module it bundles outside the Next build (the HTML edge caches,
 * their build partition, the locale redirect, the company-host route, and the two src/lib files those import). tests/unit/ci-lean-structure.test.ts walks the
 * entry's relative imports, so a module added to the entry without a line here fails CI.
 */
const WORKER_ENTRY = {
  'apps/web':
    /^apps\/web\/((sentry-worker-entry|demo-edge-cache|store-edge-cache|edge-build-id|edge-html-lang|csp-nonce-renew|locale-redirect-edge|company-host-route|ssr-client-address|resolve-unavailable-edge|resolve-miss-memo)\.ts|src\/lib\/(demo-hosts|locale-paths)\.ts)$/,
  'apps/status': /^apps\/status\/src\//,
  'apps/accounts': /^apps\/accounts\/src\//,
  // help content + capabilities are inputs of the git-ignored help corpus / registry the API bundle is built with (docs/plans/2026-11-24-help-corpus-build-time.md)
  'apps/api': /^(apps\/api\/|capabilities\/|apps\/help\/content\/)/,
  // marketing is a static export (a plain `next build`, no OpenNext): cheap enough to dry-run on any change that can
  // move its page weight, so the page-weight budget fails the PR that grows it, not a later unrelated one (#511/#525
  // pushed css over 16 KB unmeasured; Ruling MKT-LEGAL-HTML-BUDGET-2).
  'apps/marketing':
    /^(apps\/marketing\/(src|public|scripts)\/|scripts\/ci\/marketing-perf-budget\.(mjs|json)$)/,
};
const WORKER_CONFIG = dir =>
  new RegExp(
    `^${dir}/(package\\.json|wrangler\\.(jsonc|json|toml)|open-next\\.config\\.ts|next\\.config\\.[cm]?[jt]s)$`
  );
/** Root files that hit every Worker app. */
const WORKER_ROOT =
  /^(package\.json|package-lock\.json|scripts\/(cf-build\.sh|cf-setup-local\.sh|assert-cf-cache-bindings\.sh))$/;

const DOCS_ONLY = /^(docs\/|.*\.md$|\.github\/ISSUE_TEMPLATE\/|\.vscode\/|\.editorconfig$)/;

/** Integration tests that have their own CI jobs (and are excluded from the shared integration run). None since NZ-17-RLS-1. */
const OWN_JOB_INTEGRATION = new Set([]);
/** More affected test files than this and the whole tier runs (a list that long is "everything" anyway). */
const INTEGRATION_ALL_ABOVE = 40;
const SRC_EXT = ['.ts', '.tsx', '.mts', '/index.ts'];

function walkTests(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTests(p, out);
    else if (/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Repo-relative, extension-less target of an import specifier written in `testFile`, or null for packages. */
function resolveImport(spec, testFile, root) {
  let abs = null;
  if (spec.startsWith('@api/')) abs = path.join(root, 'apps/api/src', spec.slice(5));
  else if (spec.startsWith('.')) abs = path.resolve(path.dirname(testFile), spec);
  if (!abs) return null;
  return path.relative(root, abs).replace(/\.(ts|tsx|mts|js|mjs)$/, '');
}

/**
 * Which integration tests must run for this change set?
 * @returns {{ integration: boolean, paths: 'all' | string[] }}
 */
export function integrationPlan(files, root = ROOT) {
  const changed = files.filter(Boolean).filter(f => !DOCS_ONLY.test(f));
  const testDir = path.join(root, 'tests/integration');
  const tests = walkTests(testDir);
  const rel = f => path.relative(root, f);
  const run = new Set();
  let all = false;

  for (const f of changed) {
    if (/^tests\/integration\/.*\.test\.ts$/.test(f)) {
      // a test the change DELETES is in `git diff --name-only` but not in the PR head: never emit it (vitest exits 1 on "No test files found")
      if (!OWN_JOB_INTEGRATION.has(f) && existsSync(path.join(root, f))) run.add(f);
    } else if (
      f.startsWith('tests/integration/') || // fixtures, snapshots, golden files, stubs
      f.startsWith('tests/helpers/') ||
      f.startsWith('tests/stubs/') ||
      /^packages\/database\//.test(f) // schema, migrations, the client every integration test uses
    ) {
      all = true;
    }
  }

  const srcChanged = new Set(
    changed
      .filter(f => /^apps\/api\/src\//.test(f))
      .map(f => f.replace(/\.(ts|tsx|mts|js|mjs)$/, ''))
  );
  if (srcChanged.size && !all) {
    for (const t of tests) {
      const tr = rel(t);
      if (OWN_JOB_INTEGRATION.has(tr)) continue;
      const text = readFileSync(t, 'utf8');
      for (const m of text.matchAll(/(?:from|mock\(|import\()\s*['"]([^'"]+)['"]/g)) {
        const target = resolveImport(m[1], t, root);
        if (!target) continue;
        // a bare directory import resolves to its index
        if (srcChanged.has(target) || srcChanged.has(`${target}/index`)) {
          run.add(tr);
          break;
        }
      }
    }
  }

  if (all || run.size > INTEGRATION_ALL_ABOVE) return { integration: true, paths: 'all' };
  return { integration: run.size > 0, paths: [...run].sort() };
}

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
  // The generated Cloudflare schema is a function of schema.prisma + the SQL migrations. It must be re-checked
  // whenever either moves, even if someone later takes packages/database out of GLOBAL_WORKSPACES (2026-10-27:
  // #218 added models, cf-schema went red on main and nothing noticed).
  if (codeFiles.some(f => PRISMA_INPUT.test(f))) unit.add('packages/cf-schema');
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
    workers: workspaces
      .filter(w => workerTouched.has(w.dir) && w.hasWrangler)
      .map(w => w.dir.slice(5)),
    buildApps: ws.filter(w => BUILD_APPS.includes(w.dir)).map(w => w.dir.slice(5)),
    changedFiles: codeFiles,
  };
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function formatOutputs(r, integration = { integration: false, paths: [] }) {
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
    build_apps: JSON.stringify(r.buildApps),
    has_build_apps: String(r.buildApps.length > 0),
    affected: r.workspaces.join(' '),
    integration: String(integration.integration),
    integration_paths: integration.paths === 'all' ? 'all' : integration.paths.join(' '),
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
  const lines = formatOutputs(classify(files, loadWorkspaces()), integrationPlan(files));
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
