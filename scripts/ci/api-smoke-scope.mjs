#!/usr/bin/env node
/**
 * PR-CI-CHEAP-1: does a pull request need the `API Worker boots on workerd` smoke?
 *
 * CONSERVATIVE by construction: the smoke is SKIPPED only when EVERY changed file matches an allowlist of paths that
 * cannot reach the API Worker bundle or its boot. Anything else (root package.json / lockfile / tsconfig*, packages/**,
 * apps/api, apps/accounts, apps/status, wrangler configs, prisma schema, scripts/**, .github/**, an unknown path, or an
 * empty/unreadable diff) RUNS it. Node builtins only (runs before any npm ci).
 *
 * CLI: node scripts/ci/api-smoke-scope.mjs --base <sha>   -> prints `run=true|false` (+ reason on stderr)
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Paths that cannot affect the API Worker bundle. Keep this list short and obvious; when in doubt, leave it out. */
export const SAFE_PATHS = [
  /^docs\//,
  /\.md$/,
  /^apps\/(web|admin|marketing|help|docs|orders)\//,
  /^tests\/(?!integration\/|workers)/, // tests (unit, e2e, layout...) run elsewhere; not the API boot
];

export function apiSmokeInScope(files) {
  const list = files.map(f => f.trim()).filter(Boolean);
  if (list.length === 0) return { run: true, reason: 'empty diff: running to be safe' };
  const risky = list.filter(f => !SAFE_PATHS.some(re => re.test(f)));
  return risky.length
    ? {
        run: true,
        reason: `${risky.length} changed file(s) outside the safe allowlist, e.g. ${risky[0]}`,
      }
    : {
        run: false,
        reason: `all ${list.length} changed file(s) are docs/markdown/other-app/test paths`,
      };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--base');
  const base = i > -1 ? process.argv[i + 1] : '';
  let out;
  try {
    if (!base) throw new Error('no --base');
    out = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' });
  } catch (e) {
    console.log('run=true');
    console.error(`diff unreadable (${e.message}): running to be safe`);
    process.exit(0);
  }
  const r = apiSmokeInScope(out.split('\n'));
  console.log(`run=${r.run}`);
  console.error(r.reason);
}
