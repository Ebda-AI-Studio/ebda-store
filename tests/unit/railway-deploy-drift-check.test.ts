/**
 * #1490: the API deploy job is gated at JOB level on RAILWAY_ACTIONS_DEPLOY
 * so a post-cutover loss of that variable makes the job (and notify-failure,
 * which needs it) silently skip — main deploys nothing and nobody is told.
 * railway-deploy-drift-check.yml is the independent alternative named in the
 * issue: compare origin/main against what /health actually reports running,
 * on a schedule, regardless of why the pipeline stalled.
 *
 * This extracts the REAL "Compare" step script from the workflow YAML (not a
 * reimplementation) and runs it against a real git repo with a stubbed curl,
 * so the ancestor-vs-drift distinction is proven, not just read from source.
 * It runs under `bash -eo pipefail`, the shell GitHub Actions gives a `run:`
 * step, so an errexit/SIGPIPE trap in the script fails here too.
 *
 * Scoped audit, PR 1978: "ancestor of main = healthy" was unconditional, so a
 * pipeline that stopped deploying (live commit permanently an ancestor) could
 * never alert, and the job was gated on the same variable whose loss it
 * exists to detect. Both are covered below.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { if?: string; steps?: Step[] };
type Workflow = { on?: any; jobs?: Record<string, Job> };

const WF_PATH = join(__dirname, '../../.github/workflows/railway-deploy-drift-check.yml');
const doc = yaml.load(require('node:fs').readFileSync(WF_PATH, 'utf8')) as Workflow;
const compareStep = doc.jobs?.check?.steps?.find(s => s.name === 'Compare');
const DEPLOY_WF = yaml.load(
  require('node:fs').readFileSync(
    join(__dirname, '../../.github/workflows/railway-deploy.yml'),
    'utf8'
  )
) as Workflow;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * A clean environment for spawning git in a SCRATCH repo. The pre-push hook
 * (and some CI shells) run child processes with GIT_DIR/GIT_WORK_TREE/
 * GIT_INDEX_FILE already pointed at the OUTER repo — inherited by
 * execFileSync by default — which makes git operate on the wrong repository
 * ("fatal: this operation must be run in a work tree") instead of the
 * `cwd` scratch dir these fixtures create.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() });
}

/** A repo with a linear history: base -> mid -> head (returns each SHA). */
function repoWithHistory() {
  const dir = mkdtempSync(join(tmpdir(), 'drift-check-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'f'), 'base');
  git(dir, 'add', 'f');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'f'), 'mid');
  git(dir, 'commit', '-qam', 'mid');
  const mid = git(dir, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'f'), 'head');
  git(dir, 'commit', '-qam', 'head');
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  return { dir, base, mid, head };
}

/**
 * Adds one commit touching `file` (created under its directory), dated
 * `minutesAgo` minutes in the past. Returns its SHA.
 */
function commitAt(dir: string, file: string, minutesAgo: number) {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), `${file}-${Math.random()}`);
  git(dir, 'add', file);
  const when = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  execFileSync('git', ['commit', '-qm', `touch ${file}`], {
    cwd: dir,
    env: { ...cleanGitEnv(), GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
  });
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** Runs the extracted script with a curl stub on PATH returning `healthBody`. */
function runCompare(repoDir: string, healthBody: string, extraEnv: Record<string, string> = {}) {
  const binDir = mkdtempSync(join(tmpdir(), 'drift-check-bin-'));
  dirs.push(binDir);
  const curlStub = join(binDir, 'curl');
  // Ignore every curl arg; always print the fixture body (this stub also
  // stands in for the Telegram call, which no test case here reaches with a
  // token set, so it never actually posts anywhere).
  writeFileSync(curlStub, `#!/usr/bin/env bash\ncat <<'BODY'\n${healthBody}\nBODY\n`);
  chmodSync(curlStub, 0o755);

  const scriptPath = join(binDir, 'compare.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -eo pipefail\n${compareStep!.run}\n`);
  chmodSync(scriptPath, 0o755);

  // The Compare script itself runs `git rev-parse`/`git cat-file`/
  // `git merge-base` inside repoDir — needs the same clean-env treatment
  // as the `git()` helper above, for the same reason.
  return spawnSync('bash', [scriptPath], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...cleanGitEnv(),
      PATH: `${binDir}:${process.env.PATH}`,
      RAILWAY_HEALTH_URL: 'http://x',
      DRIFT_STALE_MINUTES: compareStep!.env!.DRIFT_STALE_MINUTES,
      DRIFT_MAX_BEHIND: compareStep!.env!.DRIFT_MAX_BEHIND,
      DEPLOY_PATHS: compareStep!.env!.DEPLOY_PATHS,
      DRIFT_HEALTH_RETRY_SECS: '0',
      ...extraEnv,
    },
  });
}

describe('railway-deploy-drift-check.yml Compare step', () => {
  it('the step was found (guards against a rename silently disabling this suite)', () => {
    expect(compareStep?.run).toBeTruthy();
  });

  it('passes when the live commit equals main', () => {
    const { dir, head } = repoWithHistory();
    const r = runCompare(dir, JSON.stringify({ commit: head }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('passes when the live commit is an ANCESTOR of main (deploy mid-flight)', () => {
    const { dir, mid } = repoWithHistory();
    const r = runCompare(dir, JSON.stringify({ commit: mid }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/ancestor of main/);
  });

  it('FAILS when the live commit is not an ancestor of main (real drift)', () => {
    const { dir } = repoWithHistory();
    const foreignSha = '1'.repeat(40);
    const r = runCompare(dir, JSON.stringify({ commit: foreignSha }));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Railway deploy drift/);
  });

  // Issue 2205: the unknown states used to warn and exit 0 — a blind
  // monitor reporting green. They now alert, worded as UNKNOWN (not drift).
  it('ALERTS (as blind, not drift) when /health reports commit: null', () => {
    const { dir } = repoWithHistory();
    const r = runCompare(dir, JSON.stringify({ commit: null }));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/monitor is BLIND/);
    expect(r.stdout + r.stderr).not.toMatch(/Railway deploy drift:/);
  });

  it('ALERTS when /health is unreachable (empty body) on every attempt', () => {
    const { dir } = repoWithHistory();
    const r = runCompare(dir, '');
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/could not read .* \(unreachable after 3 attempts\)/);
  });

  it('ALERTS on a body that is never JSON (e.g. a load-balancer error page)', () => {
    const { dir } = repoWithHistory();
    const r = runCompare(dir, 'not json');
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/unparseable after 3 attempts/);
  });

  it('passes when main is ahead only by commits OUTSIDE the deploy paths, however old', () => {
    const { dir, head } = repoWithHistory();
    commitAt(dir, 'apps/web/src/page.tsx', 600);
    commitAt(dir, 'docs/readme.md', 500);
    const r = runCompare(dir, JSON.stringify({ commit: head }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/nothing to deploy/);
  });

  it('passes while an undeployed API commit is younger than the stale bound (deploy in flight)', () => {
    const { dir, head } = repoWithHistory();
    commitAt(dir, 'apps/api/src/index.ts', 5);
    const r = runCompare(dir, JSON.stringify({ commit: head }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/within bounds/);
  });

  it('FAILS when an undeployed API commit is older than the stale bound (pipeline stalled)', () => {
    const { dir, head } = repoWithHistory();
    commitAt(dir, 'apps/api/src/index.ts', 180);
    commitAt(dir, 'apps/web/src/page.tsx', 1);
    const r = runCompare(dir, JSON.stringify({ commit: head }));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/STALLED/);
  });

  it('FAILS when more deploy-relevant commits are waiting than the behind bound', () => {
    const { dir, head } = repoWithHistory();
    const max = Number(compareStep!.env!.DRIFT_MAX_BEHIND);
    for (let i = 0; i <= max; i++) commitAt(dir, `packages/shared/f${i}.ts`, 1);
    const r = runCompare(dir, JSON.stringify({ commit: head }));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/STALLED/);
  });

  it('is NOT gated on RAILWAY_ACTIONS_DEPLOY (the variable whose loss it detects)', () => {
    expect(doc.jobs?.check?.if).toBeUndefined();
  });

  for (const typo of ['True', 'TRUE', '1', 'yes']) {
    it(`FAILS on a mistyped cutover switch RAILWAY_ACTIONS_DEPLOY='${typo}' before any network call`, () => {
      const { dir, head } = repoWithHistory();
      const r = runCompare(dir, JSON.stringify({ commit: head }), { RAILWAY_ACTIONS_DEPLOY: typo });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/misconfigured/);
    });
  }

  for (const value of ['', 'true', 'false']) {
    it(`does not flag RAILWAY_ACTIONS_DEPLOY='${value}' as a misconfiguration`, () => {
      const { dir, head } = repoWithHistory();
      const r = runCompare(dir, JSON.stringify({ commit: head }), {
        RAILWAY_ACTIONS_DEPLOY: value,
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  }

  it("DEPLOY_PATHS mirrors railway-deploy.yml's push paths exactly", () => {
    const pushPaths: string[] = DEPLOY_WF.on.push.paths;
    const asPathspecs = pushPaths.map(p => p.replace(/\/\*\*$/, ''));
    expect(compareStep!.env!.DEPLOY_PATHS.split(/\s+/).sort()).toEqual(asPathspecs.sort());
  });
});
