/**
 * The ONLY way a test may run git against a scratch repository.
 *
 * WHY (2026-10-25). Git hooks (husky pre-push, which runs the unit suite) export GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE
 * ... into every child process. A test that calls `git init`/`commit`/`checkout` with that inherited env does not touch
 * its temp dir: it mutates the checkout that is running the hook. One such test flipped the shared repo to
 * core.bare=true (breaking `git status` in the root checkout for everyone) and committed onto the feature branch.
 * `tests/unit/no-unsanitised-git-in-tests.test.ts` fails any test that runs a mutating git command without this helper.
 *
 *   cleanGitEnv()            process.env minus every GIT_* variable, with the user's global/system git config ignored
 *   sandboxGit(dir)          a `git` runner bound to `dir`; every call re-checks that git's toplevel IS `dir`
 *   initSandboxRepo(prefix)  mkdtemp + `git init` + toplevel check; returns { dir, git }
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export type SandboxGit = (...args: string[]) => string;

export function sandboxGit(dir: string): SandboxGit {
  const real = realpathSync(dir);
  return (...args: string[]) => {
    const out = execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        env: cleanGitEnv(),
      }
    ).trim();
    // after init, git must see THIS directory as the repository root, never an enclosing or inherited one
    if (args[0] !== 'init') {
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanGitEnv(),
      }).trim();
      if (realpathSync(top) !== real)
        throw new Error(`git toplevel ${top} is not the sandbox ${dir}: refusing to continue`);
    }
    return out;
  };
}

export function initSandboxRepo(
  prefix = 'sandbox-',
  branch = 'main'
): { dir: string; git: SandboxGit } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = sandboxGit(dir);
  git('init', '-q', '-b', branch);
  git('rev-parse', '--git-dir'); // runs the toplevel check
  return { dir, git };
}
