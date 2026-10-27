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
 *
 * Usage: node scripts/ci/pre-push-plan.mjs --base <sha>   |   --files a,b,c   (no git; tests)
 */
import { execFileSync } from 'node:child_process';
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
        JSON.stringify({ mode: 'full', lint: [], typecheck: [], related: [], files: [] })
      );
    files = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
  }
  console.log(JSON.stringify(plan(files, loadWorkspaces())));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
