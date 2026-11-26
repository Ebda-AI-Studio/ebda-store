import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGitEnv } from '../helpers/git-env';

// 2026-11-23, twice: `cd <worktree> && git merge ...` failed at the cd, so git ran in the ROOT checkout and moved
// local main ahead of origin. husky repoints the hooks path to .husky/_, so the global ~/.claude/git-hooks never run
// in this repo: the vendored guard (scripts/ci/root-checkout-guard.sh, from ebda-foundation os/ops) is called from
// the husky hooks themselves. Real git, real hook files, in a sandbox laid out like
// ~/Desktop/projects/<biz>/internal-projects/<repo>.
const ROOT = join(__dirname, '../../');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'rcg-')));
const home = join(tmp, 'home');
const projects = join(home, 'Desktop/projects');
const repo = join(projects, 'Ebda-AI-Studio/internal-projects/sandbox-store');
const stubBin = join(tmp, 'bin');
mkdirSync(stubBin, { recursive: true });
writeFileSync(join(stubBin, 'npx'), '#!/bin/sh\nexit 0\n'); // lint-staged is not under test
chmodSync(join(stubBin, 'npx'), 0o755);

const env = (extra: Record<string, string> = {}) =>
  cleanGitEnv({
    HOME: home,
    OS_PROJECTS_DIR: projects,
    PATH: `${stubBin}:${process.env.PATH}`,
    ...extra,
  });
const git = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: env(extra) }
  );
const must = (r: ReturnType<typeof git>) => {
  if (r.status !== 0) throw new Error(`git failed: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
};
const commitIn = (cwd: string, extra: Record<string, string> = {}, file = 'f.txt') => {
  writeFileSync(join(cwd, file), String(Math.random()));
  must(git(cwd, ['add', file]));
  return git(cwd, ['commit', '-q', '-m', 'x'], extra);
};

// vendored copy + hooks laid into the sandbox exactly as committed in this repo
mkdirSync(join(repo, '.husky'), { recursive: true });
mkdirSync(join(repo, 'scripts/ci'), { recursive: true });
for (const f of [
  '.husky/pre-commit',
  '.husky/pre-merge-commit',
  'scripts/ci/root-checkout-guard.sh',
]) {
  copyFileSync(join(ROOT, f), join(repo, f));
  chmodSync(join(repo, f), 0o755);
}
must(git(repo, ['init', '-q', '-b', 'main']));
must(git(repo, ['add', '.husky', 'scripts']));
must(git(repo, ['commit', '-q', '-m', 'init'])); // before the hooks path is pointed at .husky
must(git(repo, ['config', 'core.hooksPath', '.husky']));

describe('ROOT-GUARD-HUSKY-1: root checkout refuses commits and merge commits', () => {
  it('the committed hooks call the vendored guard', () => {
    expect(existsSync(join(ROOT, 'scripts/ci/root-checkout-guard.sh'))).toBe(true);
    expect(readFileSync(join(ROOT, '.husky/pre-commit'), 'utf8')).toContain(
      'root-checkout-guard.sh" pre-commit'
    );
    expect(readFileSync(join(ROOT, '.husky/pre-merge-commit'), 'utf8')).toContain(
      'root-checkout-guard.sh" pre-merge-commit'
    );
  });

  it('refuses a commit in the main checkout on main and names the worktree script', () => {
    const r = commitIn(repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('new-task-worktree.sh');
  });

  it('allows a commit in a linked worktree', () => {
    const wt = join(tmp, 'wt');
    must(git(repo, ['worktree', 'add', '-q', '-b', 'feat/x', wt]));
    expect(commitIn(wt).status).toBe(0);
  });

  it('refuses a non-ff merge on root main, allows a ff merge', () => {
    must(git(repo, ['reset', '-q', '--hard', 'HEAD']));
    must(git(repo, ['merge', '-q', '--ff-only', 'feat/x'])); // ff: no pre-merge-commit runs
    const wt2 = join(tmp, 'wt2');
    must(git(repo, ['worktree', 'add', '-q', '-b', 'feat/y', wt2]));
    expect(commitIn(wt2).status).toBe(0);
    // give main its own commit so feat/y cannot fast-forward: that commit goes in through the hatch
    expect(commitIn(repo, { EBDA_ALLOW_ROOT_COMMIT: '1' }, 'main-only.txt').status).toBe(0);
    const before = must(git(repo, ['rev-parse', 'main']));
    const m = git(repo, ['merge', '--no-ff', '-q', '-m', 'm', 'feat/y']);
    expect(m.status).not.toBe(0);
    expect(m.stderr).toContain('root-checkout-guard: REFUSED pre-merge-commit');
    git(repo, ['merge', '--abort']);
    expect(must(git(repo, ['rev-parse', 'main']))).toBe(before);
  });

  it('the escape hatch is logged', () => {
    const log = join(home, 'Library/Logs/root-commit-guard.log');
    expect(readFileSync(log, 'utf8')).toContain('pre-commit ALLOWED via EBDA_ALLOW_ROOT_COMMIT=1');
  });
});
