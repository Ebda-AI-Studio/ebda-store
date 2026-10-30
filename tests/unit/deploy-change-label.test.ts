import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { changedFiles, check, LABEL } from '../../scripts/ci/deploy-change-label.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'dcl-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Isolated env: a hook may export GIT_DIR (test-isolation standard).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a],
    {
      cwd,
      env,
      encoding: 'utf8',
    }
  ).trim();
const commit = (cwd: string, file: string, msg: string) => {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), msg + Math.random());
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', msg);
};

/** Reproduces CI: PR branched from `base`, main then gained `mainFile`, HEAD = merge of PR into the new main. */
function scenario(name: string, prFile: string, mainFile: string) {
  const cwd = path.join(dir, name);
  mkdirSync(cwd);
  git(cwd, 'init', '-b', 'main');
  commit(cwd, 'README.md', 'init');
  const staleBase = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'checkout', '-b', 'pr');
  commit(cwd, prFile, 'pr change');
  git(cwd, 'checkout', 'main');
  commit(cwd, mainFile, 'main gains deploy change');
  git(cwd, 'checkout', '--detach', 'main');
  git(cwd, 'merge', '--no-ff', 'pr', '-m', 'merge');
  return { cwd, staleBase };
}

describe('deploy-change-label', () => {
  it('passes a PR with no deploy files even when main gained deploy changes after the PR base', () => {
    const { cwd, staleBase } = scenario(
      'clean',
      'src/app.ts',
      '.github/workflows/cf-api-deploy.yml'
    );
    const files = changedFiles(cwd, staleBase);
    expect(files).toEqual(['src/app.ts']);
    expect(check(files, []).ok).toBe(true);
  });

  it('fails a PR touching cf-api-deploy.yml without the label and passes with it', () => {
    const { cwd, staleBase } = scenario(
      'deploy',
      '.github/workflows/cf-api-deploy.yml',
      'docs/x.md'
    );
    const files = changedFiles(cwd, staleBase);
    expect(files).toEqual(['.github/workflows/cf-api-deploy.yml']);
    expect(check(files, []).ok).toBe(false);
    expect(check(files, [LABEL]).ok).toBe(true);
  });

  it('falls back to base...HEAD on a non-merge HEAD', () => {
    const cwd = path.join(dir, 'linear');
    mkdirSync(cwd);
    git(cwd, 'init', '-b', 'main');
    commit(cwd, 'README.md', 'init');
    const base = git(cwd, 'rev-parse', 'HEAD');
    commit(cwd, 'scripts/cf-build.sh', 'deploy');
    expect(changedFiles(cwd, base)).toEqual(['scripts/cf-build.sh']);
  });
});
