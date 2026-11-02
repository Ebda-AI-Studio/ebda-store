#!/usr/bin/env node
/**
 * Ruling CI-BUDGET-2: should THIS app's push deploy run? A cf-<app>-deploy.yml `paths:` trigger is coarse (a lockfile or
 * shared-script edit starts every app, and so does an edit to a deploy workflow itself). The first job of each deploy
 * workflow runs this on the pushed range and skips the real deploy job, in seconds, when the app's deployable output
 * cannot have changed. The workflow's own `paths:` list stays the single source of what an app is built from; this
 * only refines it:
 *   - a file under `.github/` never deploys (config-only); a deploy is forced by workflow_dispatch or `[force-deploy]` in
 *     the head commit message;
 *   - `scripts/ci/deploy-guard.mjs` and `scripts/ci/workerd-smoke.*` are the deploy's own checks, not bundle inputs;
 *   - `package-lock.json` deploys the app only if a lock entry its dependency closure reaches changed;
 *   - any other file matching the app's paths deploys it. Anything unreadable fails OPEN (deploy).
 * Usage: node scripts/ci/deploy-plan.mjs --app web --event push --before <sha> --sha <sha>
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCK = 'package-lock.json';
const NOT_BUNDLE_INPUTS = [/^scripts\/ci\/deploy-guard\.mjs$/, /^scripts\/ci\/workerd-smoke\./];

/** The `push.paths` globs of a workflow's text (the `- '...'` items under `paths:`), minus the workflow's own file. */
export function triggerPaths(workflowText) {
  const lines = workflowText.split('\n');
  const start = lines.findIndex(l => /^\s{4}paths:\s*$/.test(l));
  if (start === -1) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^\s{6}-\s+'([^']+)'/.exec(l);
    if (m) out.push(m[1]);
    else if (!/^\s*(#.*)?$/.test(l)) break;
  }
  return out.filter(p => !p.startsWith('.github/'));
}

export function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`);
}

const resolveDep = (lock, from, name) => {
  let base = from;
  for (;;) {
    const key = `${base}/node_modules/${name}`.replace(/^\//, '');
    if (lock.packages[key]) return key;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i === -1 ? '' : base.slice(0, i);
  }
};

/** Every lock entry reachable from the roots (workspace keys), following links and the four dependency kinds. */
export function lockClosure(lock, roots) {
  const seen = new Set();
  const todo = [...roots];
  while (todo.length) {
    const key = todo.pop();
    if (seen.has(key) || !lock.packages[key]) continue;
    seen.add(key);
    const e = lock.packages[key];
    if (e.link && e.resolved) todo.push(e.resolved);
    const deps = {
      ...e.dependencies,
      ...e.optionalDependencies,
      ...e.peerDependencies,
      ...(key.includes('node_modules') ? {} : e.devDependencies),
    };
    for (const name of Object.keys(deps)) {
      const dep = resolveDep(lock, key, name);
      if (dep) todo.push(dep);
    }
  }
  return seen;
}

/** Whether a lockfile change can alter this app: a changed entry inside its dependency closure (before or after). */
export function lockAffects(before, after, appPaths) {
  const roots = k =>
    !k.includes('node_modules') && k && appPaths.some(r => r.test(`${k}/package.json`));
  const keys = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
  const changed = [...keys].filter(
    k => JSON.stringify(before.packages[k]) !== JSON.stringify(after.packages[k])
  );
  if (changed.length === 0) return null;
  const closure = new Set([
    ...lockClosure(before, Object.keys(before.packages).filter(roots)),
    ...lockClosure(after, Object.keys(after.packages).filter(roots)),
  ]);
  return changed.find(k => closure.has(k)) ?? null;
}

/**
 * @param {{ paths: string[], files: string[], force?: boolean, readLocks?: () => ({before:any, after:any}) }} a
 * @returns {{ deploy: boolean, reason: string }}
 */
export function planDeploy({ paths, files, force = false, readLocks }) {
  if (force) return { deploy: true, reason: 'forced (workflow_dispatch or [force-deploy])' };
  const res = paths.map(globToRegExp);
  const hit = [];
  let lockChanged = false;
  for (const f of files.filter(Boolean)) {
    if (f.startsWith('.github/')) continue;
    if (NOT_BUNDLE_INPUTS.some(r => r.test(f))) continue;
    if (!res.some(r => r.test(f))) continue;
    if (f === LOCK) lockChanged = true;
    else hit.push(f);
  }
  if (hit.length > 0) {
    return {
      deploy: true,
      reason: `changed: ${hit.slice(0, 5).join(', ')}${hit.length > 5 ? ' ...' : ''}`,
    };
  }
  if (lockChanged) {
    try {
      const { before, after } = readLocks();
      const entry = lockAffects(before, after, res);
      if (entry)
        return {
          deploy: true,
          reason: `package-lock.json changed ${entry}, which this app depends on`,
        };
      return {
        deploy: false,
        reason: 'package-lock.json changed only entries this app does not depend on',
      };
    } catch (e) {
      return {
        deploy: true,
        reason: `package-lock.json diff unreadable (${e.message}); deploying to be safe`,
      };
    }
  }
  return {
    deploy: false,
    reason: 'no file this app is built from changed (workflow/config-only or other apps)',
  };
}

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

function main(argv) {
  const arg = n => argv[argv.indexOf(`--${n}`) + 1];
  const app = arg('app');
  const event = arg('event');
  const before = arg('before');
  const sha = arg('sha') || 'HEAD';
  const text = readFileSync(path.join(ROOT, '.github/workflows', `cf-${app}-deploy.yml`), 'utf8');
  const paths = triggerPaths(text);
  let result;
  try {
    if (
      event === 'workflow_dispatch' ||
      /\[force-deploy\]/.test(git('log', '-1', '--format=%B', sha))
    ) {
      result = planDeploy({ paths, files: [], force: true });
    } else if (!before || /^0+$/.test(before)) {
      result = { deploy: true, reason: 'no previous commit to diff against; deploying' };
    } else {
      const files = git('diff', '--name-only', before, sha).split('\n');
      result = planDeploy({
        paths,
        files,
        readLocks: () => ({
          before: JSON.parse(git('show', `${before}:${LOCK}`)),
          after: JSON.parse(git('show', `${sha}:${LOCK}`)),
        }),
      });
    }
  } catch (e) {
    result = {
      deploy: true,
      reason: `could not compute the changed files (${e.message}); deploying to be safe`,
    };
  }
  const line = `${result.deploy ? 'DEPLOY' : 'SKIP'} ${app}: ${result.reason}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${result.deploy}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
