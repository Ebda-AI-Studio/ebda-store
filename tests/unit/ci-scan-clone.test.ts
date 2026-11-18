/**
 * Ruling CI-TRUFFLE-FRESH-1: the Mac secret scan reads a PRIVATE fresh shallow clone (scripts/ci/scan-clone.sh), never the CI workspace.
 * Reproduces the production state: a workspace left by a `filter: blob:none` fetch whose promisor CONFIG KEYS are gone but whose
 * `.git/objects/pack/*.promisor` marker packs remain (main run 44268095513: "the workspace is a full clone" yet `git clone file://$PWD` still failed
 * "could not fetch ... from promisor remote"). Control: that state fails the local clone, so the test proves the script, not luck, fixes it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { cleanGitEnv, initSandboxRepo, sandboxGit, type SandboxGit } from '../helpers/git-env';

const SCRIPT = join(__dirname, '../../scripts/ci/scan-clone.sh');
const ENV = cleanGitEnv({
  GITHUB_ACTIONS: 'true',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
});
let root: string;
let src: string;
let git: SandboxGit;

/** A workspace in the production state: depth-1 blob:none fetch, no checkout, config keys removed, .promisor packs left behind. */
function poisonedWorkspace(name: string): string {
  const ws = join(root, name);
  execFileSync(
    'git',
    ['clone', '-q', '--depth=1', '--filter=blob:none', '--no-checkout', `file://${src}`, ws],
    { env: ENV }
  );
  const g = sandboxGit(ws);
  g('config', '--unset-all', 'remote.origin.promisor');
  g('config', '--unset-all', 'remote.origin.partialclonefilter');
  return ws;
}
const promisorPacks = (ws: string) =>
  readdirSync(join(ws, '.git/objects/pack')).filter(f => f.endsWith('.promisor'));
const localClone = (from: string, name: string) =>
  spawnSync('git', ['clone', '-q', `file://${from}`, join(root, name)], {
    env: ENV,
    encoding: 'utf8',
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sc-'));
  const sb = initSandboxRepo('sc-src-');
  src = sb.dir;
  git = sb.git;
  git('config', 'uploadpack.allowFilter', 'true');
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (const i of [1, 2, 3]) {
    writeFileSync(join(src, `f${i}.txt`), `v${i} ${Math.random()}\n`);
    git('add', '.');
    git('commit', '-qm', `c${i}`);
  }
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

describe('scan-clone.sh', () => {
  it('control: the production state (marker packs, no config keys) cannot be cloned locally, so the scanner must not read the workspace', () => {
    const ws = poisonedWorkspace('ws-control');
    expect(promisorPacks(ws).length, 'the state must have promisor marker packs').toBeGreaterThan(
      0
    );
    expect(
      spawnSync('git', ['config', '--get', 'remote.origin.promisor'], { cwd: ws, env: ENV }).status
    ).not.toBe(0);
    const r = localClone(ws, 'scan-control');
    expect(r.status, 'if this passes the control no longer reproduces the runner failure').not.toBe(
      0
    );
  });

  it('a fresh clone of the commit is complete and clonable in the same poisoned state, and the workspace is not touched', () => {
    const ws = poisonedWorkspace('ws-fixed');
    const sha = git('rev-parse', 'HEAD');
    const before = promisorPacks(ws).join(',');
    const dest = join(root, 'scan-fresh');
    const out = execFileSync('bash', [SCRIPT, sha, dest, '3'], {
      cwd: ws,
      env: ENV,
      encoding: 'utf8',
    });
    expect(out).toContain('scan-clone:');
    expect(out).toContain('3 commits');
    const r = localClone(dest, 'scanner-view');
    expect(r.status, r.stderr).toBe(0);
    expect(sandboxGit(join(root, 'scanner-view'))('cat-file', '-p', 'HEAD:f1.txt')).toMatch(/^v1 /);
    expect(promisorPacks(dest)).toEqual([]);
    expect(promisorPacks(ws).join(',')).toBe(before); // the workspace was only read
  });

  it('replaces a leftover destination and honours the depth', () => {
    const ws = poisonedWorkspace('ws-depth');
    const sha = git('rev-parse', 'HEAD');
    const dest = join(root, 'scan-depth');
    execFileSync('bash', [SCRIPT, sha, dest, '3'], { cwd: ws, env: ENV, encoding: 'utf8' });
    const again = execFileSync('bash', [SCRIPT, sha, dest, '1'], {
      cwd: ws,
      env: ENV,
      encoding: 'utf8',
    });
    expect(again).toContain('1 commits');
  });

  it('refuses outside GitHub Actions (a shallow fetch would make a developer repo shallow), on a bad depth, and without arguments', () => {
    const ws = poisonedWorkspace('ws-refuse');
    const env = { ...ENV };
    delete env.GITHUB_ACTIONS;
    const noGh = spawnSync('bash', [SCRIPT, 'HEAD', join(root, 'x'), '3'], {
      cwd: ws,
      env,
      encoding: 'utf8',
    });
    expect(noGh.status).toBe(2);
    expect(noGh.stderr).toContain('refusing');
    expect(
      spawnSync('bash', [SCRIPT, 'HEAD', join(root, 'y'), 'abc'], { cwd: ws, env: ENV }).status
    ).toBe(2);
    expect(spawnSync('bash', [SCRIPT], { env: ENV }).status).not.toBe(0);
  });
});

describe('ci.yml wiring', () => {
  const doc = yaml.load(
    readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8')
  ) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const steps = Object.values(doc.jobs).flatMap(j => j.steps ?? []);
  const mac = steps.find(s => (s.name ?? '').startsWith('Check for secrets (Mac runner'));
  const run = mac?.run ?? '';
  it('the Mac secret scan builds the private clone first and points trufflehog at it, never at the workspace', () => {
    expect(run).toBeTruthy();
    const a = run.indexOf('scripts/ci/scan-clone.sh');
    const b = run.indexOf('trufflehog" git');
    expect(a, 'scan-clone.sh must be called').toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(run).toContain('trufflehog" git "file://$SCAN"');
    expect(run).not.toContain('file://$PWD');
  });
  it('the since-commit range is checked in the private clone, and the old in-workspace deepen is gone', () => {
    expect(run).toContain('git -C "$SCAN" merge-base --is-ancestor "$BEFORE" "$AFTER"');
    expect(run).not.toMatch(/git fetch[^\n]*--deepen/);
  });
});
