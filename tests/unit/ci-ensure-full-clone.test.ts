/**
 * Ruling CI-TRUFFLE-PARTIAL-1: the Mac secret scan clones the runner workspace locally, and a workspace left as a PARTIAL clone by an earlier
 * job makes that clone abort (main run 44223670604). scripts/ci/ensure-full-clone.sh makes the workspace a full clone first.
 * Control: the same broken state, without the script, fails the local clone, so the test proves the script is what fixes it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

const SCRIPT = join(__dirname, '../../scripts/ci/ensure-full-clone.sh');
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' });
let root: string;
let src: string;

/** A workspace cloned depth 1 with a blob filter and NO checkout: blobs are missing, exactly the runner state. */
function brokenWorkspace(name: string): string {
  const ws = join(root, name);
  execFileSync(
    'git',
    ['clone', '-q', '--depth=1', '--filter=blob:none', '--no-checkout', `file://${src}`, ws],
    { env: ENV }
  );
  return ws;
}
const localClone = (ws: string, name: string) =>
  spawnSync('git', ['clone', '-q', `file://${ws}`, join(root, name)], {
    env: ENV,
    encoding: 'utf8',
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'efc-'));
  src = join(root, 'src');
  execFileSync('git', ['init', '-q', src], { env: ENV });
  git(src, 'config', 'uploadpack.allowFilter', 'true');
  git(src, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (const i of [1, 2, 3]) {
    writeFileSync(join(src, `f${i}.txt`), `v${i} ${Math.random()}\n`);
    git(src, 'add', '.');
    git(src, 'commit', '-qm', `c${i}`);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('ensure-full-clone.sh', () => {
  it('control: a partial-clone workspace with missing blobs cannot be cloned locally', () => {
    const ws = brokenWorkspace('ws-control');
    const r = localClone(ws, 'scan-control');
    expect(r.status, 'if this passes the control no longer reproduces the runner failure').not.toBe(
      0
    );
  });

  it('after the script the same workspace clones locally and the blobs are readable', () => {
    const ws = brokenWorkspace('ws-fixed');
    const sha = git(src, 'rev-parse', 'HEAD').trim();
    const out = execFileSync('bash', [SCRIPT, sha], { cwd: ws, env: ENV, encoding: 'utf8' });
    expect(out).toContain('partial clone');
    const r = localClone(ws, 'scan-fixed');
    expect(r.status, r.stderr).toBe(0);
    expect(git(join(root, 'scan-fixed'), 'cat-file', '-p', 'HEAD:f1.txt')).toMatch(/^v1 /);
    expect(
      spawnSync('git', ['config', '--get', 'remote.origin.promisor'], { cwd: ws, env: ENV }).status
    ).not.toBe(0);
  });

  it('is a no-op on a full clone', () => {
    const ws = join(root, 'ws-full');
    execFileSync('git', ['clone', '-q', `file://${src}`, ws], { env: ENV });
    const sha = git(src, 'rev-parse', 'HEAD').trim();
    expect(execFileSync('bash', [SCRIPT, sha], { cwd: ws, env: ENV, encoding: 'utf8' })).toContain(
      'full clone'
    );
  });

  it('refuses to run without a sha', () => {
    expect(spawnSync('bash', [SCRIPT], { env: ENV }).status).not.toBe(0);
  });
});

describe('ci.yml wiring', () => {
  const doc = yaml.load(
    readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8')
  ) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const steps =
    doc.jobs['security-audit']?.steps ?? Object.values(doc.jobs).flatMap(j => j.steps ?? []);
  const mac = steps.find(s => (s.name ?? '').startsWith('Check for secrets (Mac runner'));
  it('the Mac secret scan runs ensure-full-clone.sh before trufflehog clones the workspace', () => {
    expect(mac?.run).toBeTruthy();
    const run = mac?.run ?? '';
    const a = run.indexOf('scripts/ci/ensure-full-clone.sh');
    const b = run.indexOf('trufflehog" git "file://$PWD"');
    expect(a, 'ensure-full-clone.sh must be called').toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });
});
