/**
 * cf-deploy's `detect` job must diff against the LAST SUCCESSFUL deploy, not HEAD~1.
 *
 * The workflow's concurrency group cancels a superseded run. With a HEAD~1 diff,
 * two back-to-back merges meant the first run was cancelled and the second only
 * diffed its OWN commit, so the first merge's app changes never deployed
 * (2026-09-30: #2218's admin changes, run dc47b3c5 cancelled, run 8f7ff845 for
 * #1983 diffed only itself).
 *
 * The static checks alone would pass a script that never runs, so the detect
 * step's own `run:` block is extracted from the workflow and EXECUTED here,
 * against a throwaway git repo, with a stub `gh` standing in for the
 * last-successful-run lookup. Each case reads the step's real GITHUB_OUTPUT.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/cf-deploy.yml');

/** The detect job's text, from `  detect:` up to the next top-level job. */
function detectJob(): string {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const start = yml.indexOf('\n  detect:\n');
  const end = yml.indexOf('\n  deploy-web:\n');
  expect(start, 'detect job not found').toBeGreaterThan(0);
  expect(end, 'deploy-web job not found').toBeGreaterThan(start);
  return yml.slice(start, end);
}

/** The `run: |` block of the detect step (id: f), de-indented to plain bash. */
function detectScript(): string {
  const lines = detectJob().split('\n');
  const stepAt = lines.findIndex(l => /^\s+- id: f\s*$/.test(l));
  expect(stepAt, 'detect step `id: f` not found').toBeGreaterThan(0);
  const runAt = lines.findIndex((l, i) => i > stepAt && /^\s+run: \|\s*$/.test(l));
  expect(runAt, 'detect step has no `run: |` block').toBeGreaterThan(stepAt);
  const indent = lines[runAt].indexOf('run:') + 2;
  const body: string[] = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== '' && l.search(/\S/) < indent) break;
    body.push(l.slice(indent));
  }
  const script = body.join('\n');
  expect(script.length, 'extracted an empty script').toBeGreaterThan(200);
  return script;
}

/** Script lines with comments stripped — what actually executes. */
function codeLines(script: string): string[] {
  return script
    .split('\n')
    .map(l => l.replace(/^\s*#.*$/, ''))
    .filter(l => l.trim() !== '');
}

describe('cf-deploy detect: static shape', () => {
  it('does not diff against HEAD~1 / HEAD^ / github.event.before', () => {
    const code = codeLines(detectScript()).join('\n');
    expect(code).not.toMatch(/HEAD~|HEAD\^|event\.before/);
    // …and does look up the last successful run of THIS workflow on main.
    expect(code).toMatch(/gh run list[\s\S]*--workflow cf-deploy\.yml/);
    expect(code).toMatch(/--branch main/);
    expect(code).toMatch(/--status success/);
  });

  it('checks out full history and may read Actions runs', () => {
    const job = detectJob();
    // fetch-depth: 2 can only ever diff HEAD~1.
    expect(job).toMatch(/fetch-depth: 0/);
    expect(job).toMatch(/permissions:[\s\S]*actions: read/);
    expect(job).toMatch(/permissions:[\s\S]*contents: read/);
    expect(job).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
  });
});

// Strip GIT_* — under the husky pre-push hook git exports GIT_DIR etc. for
// the OUTER repo, and every child git below would then write to it (it added
// fixture commits to a branch and set core.bare=true on 2026-09-30). Same
// fix as ai-review-autofix-file-staging.test.ts.
const CLEAN_GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

describe('cf-deploy detect: behaviour (script executed against a real git repo)', () => {
  let tmp: string;
  let repo: string;
  let bin: string;
  const sha: Record<string, string> = {};
  let script: string;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: CLEAN_GIT_ENV }).trim();

  function commit(name: string, file: string) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), `${name}\n`);
    git('add', file);
    git('commit', '-q', '-m', name);
    sha[name] = git('rev-parse', 'HEAD');
  }

  beforeAll(() => {
    script = detectScript();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-detect-'));
    repo = path.join(tmp, 'repo');
    bin = path.join(tmp, 'bin');
    fs.mkdirSync(repo);
    fs.mkdirSync(bin);
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: CLEAN_GIT_ENV });
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    commit('c0', 'README.md');
    commit('c1-admin', 'apps/admin/page.tsx'); // the merge whose run was CANCELLED
    commit('c2-web', 'apps/web/page.tsx'); // the merge whose run survived
    // Stub gh: prints $GH_STUB_OUT, exits $GH_STUB_EXIT, and records that it ran.
    fs.writeFileSync(
      path.join(bin, 'gh'),
      '#!/usr/bin/env bash\ntouch "$GH_STUB_CALLED"\nprintf "%s" "${GH_STUB_OUT:-}"\nexit "${GH_STUB_EXIT:-0}"\n',
      { mode: 0o755 }
    );
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(opts: { event?: string; ghOut?: string; ghExit?: number; head?: string }) {
    git('checkout', '-q', opts.head ?? sha['c2-web']);
    const out = path.join(tmp, `out-${Math.random().toString(36).slice(2)}`);
    const called = `${out}.gh-called`;
    fs.writeFileSync(out, '');
    const res = spawnSync('bash', ['-c', script], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...CLEAN_GIT_ENV,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        GITHUB_REPOSITORY: 'ForceAI-KW/force-website-builder',
        GH_TOKEN: 'stub',
        EVENT_NAME: opts.event ?? 'push',
        GH_STUB_OUT: opts.ghOut ?? '',
        GH_STUB_EXIT: String(opts.ghExit ?? 0),
        GH_STUB_CALLED: called,
      },
    });
    expect(res.status, `detect script exited ${res.status}\n${res.stdout}\n${res.stderr}`).toBe(0);
    const outputs = Object.fromEntries(
      fs
        .readFileSync(out, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => l.split('=') as [string, string])
    );
    return { outputs, ghCalled: fs.existsSync(called), log: res.stdout };
  }

  const ALL = { web: 'true', admin: 'true', orders: 'true' };
  const NONE = { web: 'false', admin: 'false', orders: 'false' };

  it('a cancelled run is not stranded: diffing from the last success deploys BOTH merges', () => {
    // Last success = c0. c1 (admin) was cancelled; this run is c2 (web).
    // HEAD~1 would have said admin=false — the 2026-09-30 incident.
    const { outputs } = run({ ghOut: sha.c0 });
    expect(outputs).toEqual({ web: 'true', admin: 'true', orders: 'false' });
  });

  it('a normal single-merge run deploys only the app that changed', () => {
    const { outputs } = run({ ghOut: sha['c1-admin'] });
    expect(outputs).toEqual({ web: 'true', admin: 'false', orders: 'false' });
  });

  it('FAIL SAFE: the last-success lookup failing deploys everything', () => {
    const { outputs, ghCalled } = run({ ghExit: 1 });
    expect(ghCalled).toBe(true);
    expect(outputs).toEqual(ALL);
  });

  it('FAIL SAFE: no previous successful run deploys everything', () => {
    expect(run({ ghOut: '' }).outputs).toEqual(ALL);
  });

  it('FAIL SAFE: a sha that is not in the checkout deploys everything', () => {
    expect(run({ ghOut: 'f'.repeat(40) }).outputs).toEqual(ALL);
  });

  it('FAIL SAFE: garbage from the lookup deploys everything', () => {
    expect(run({ ghOut: 'not-a-sha' }).outputs).toEqual(ALL);
  });

  it('re-running the commit that last succeeded deploys everything', () => {
    expect(run({ ghOut: sha['c2-web'] }).outputs).toEqual(ALL);
  });

  it('a stale re-run of a commit already contained in the last success deploys nothing (no rollback)', () => {
    expect(run({ ghOut: sha['c2-web'], head: sha['c1-admin'] }).outputs).toEqual(NONE);
  });

  it('workflow_dispatch deploys everything without consulting the lookup', () => {
    const { outputs, ghCalled } = run({ event: 'workflow_dispatch', ghExit: 1 });
    expect(outputs).toEqual(ALL);
    expect(ghCalled).toBe(false);
  });
});

describe('railway-deploy: the hourly probe cannot cancel a pending deploy', () => {
  it('schedule runs use a different concurrency group from push/dispatch runs', () => {
    // GitHub keeps ONE pending run per group and cancels the older pending run
    // when a new one queues — cancel-in-progress: false only protects the
    // running one. A shared group let the hourly cron (which skips the deploy
    // job) cancel a queued push deploy, stranding its API change.
    const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/railway-deploy.yml'), 'utf8');
    const group = /^concurrency:\n(?:\s*#.*\n)*\s+group:\s*(.+)$/m.exec(yml)?.[1] ?? '';
    expect(group, 'top-level concurrency group not found').not.toBe('');
    expect(group).toMatch(/github\.event_name == 'schedule'/);
    expect(yml).toMatch(/^\s+cancel-in-progress: false$/m);
  });
});
