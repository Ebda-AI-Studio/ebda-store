/**
 * Guard (2026-10-25): a test that runs a MUTATING git command (init, commit, checkout, config, add, reset, worktree ...)
 * must do it through tests/helpers/git-env.ts. Hooks export GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE; a test that inherits
 * them mutates the checkout running the hook (it flipped the shared repo to core.bare=true and committed onto a
 * feature branch). Read-only git (ls-files, grep, diff, log, rev-parse, status, show, cat-file) against the real repo is
 * fine and is not flagged.
 *
 * Mutation-proof: the self-test section runs the detector on a bad snippet and on a good one.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const MUTATING =
  'init|commit|checkout|switch|config|add|rm|mv|reset|clean|restore|stash|branch|tag|merge|rebase|cherry-pick|revert|am|apply|clone|fetch|pull|push|remote|worktree|update-ref|symbolic-ref|read-tree|write-tree|commit-tree|gc|prune|filter-branch|submodule';
// git invoked from JS: execFileSync('git', ['init' ...]) / spawnSync("git", ["commit"...]) / exec('git commit ...') / `git commit` in a template
const ARGV_FORM = new RegExp(
  `['"\`]git['"\`]\\s*,\\s*(?:\\[\\s*)?(?:['"\`]-[^'"\`]*['"\`]\\s*,\\s*['"\`][^'"\`]*['"\`]\\s*,\\s*)*['"\`](?:${MUTATING})['"\`]`
);
const SHELL_FORM = new RegExp(
  `(?:exec|execSync|spawn|spawnSync|execa|\\$)\\s*\\(?\\s*['"\`][^'"\`\\n]*\\bgit\\s+(?:-[A-Za-z]\\s+\\S+\\s+)*(?:${MUTATING})\\b`
);
const HELPER_IMPORT = /helpers\/git-env['"]/;

export function runsUnsanitisedMutatingGit(src: string): boolean {
  if (HELPER_IMPORT.test(src)) return false;
  return ARGV_FORM.test(src) || SHELL_FORM.test(src);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === '.next' || e === '.open-next')
      continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (
      /(\.test|\.spec)\.(ts|tsx|mts|mjs|js)$/.test(e) ||
      /(^|\/)tests\/.*\.(ts|mjs)$/.test(p.replace(ROOT, ''))
    )
      out.push(p);
  }
  return out;
}

describe('tests never run mutating git without the sanitised helper', () => {
  it('self-test: the detector flags the bad shapes and spares the good ones', () => {
    expect(runsUnsanitisedMutatingGit(`execFileSync('git', ['init', '-q'], { cwd })`)).toBe(true);
    expect(
      runsUnsanitisedMutatingGit(`spawnSync("git", ["-c", "user.name=t", "commit", "-qm", "x"])`)
    ).toBe(true);
    expect(runsUnsanitisedMutatingGit("execSync('git checkout -b x', { cwd })")).toBe(true);
    expect(runsUnsanitisedMutatingGit('execSync(`git config user.email a@b`)')).toBe(true);
    expect(
      runsUnsanitisedMutatingGit(
        `import { initSandboxRepo } from '../helpers/git-env';\nexecFileSync('git', ['init'])`
      )
    ).toBe(false);
    expect(
      runsUnsanitisedMutatingGit(`execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })`)
    ).toBe(false);
    expect(runsUnsanitisedMutatingGit(`execSync("git grep -l foo -- 'scripts/*.sh'")`)).toBe(false);
    expect(runsUnsanitisedMutatingGit(`const msg = 'a git commit message'`)).toBe(false);
  });

  it('finds test files to scan (the guard is not vacuous)', () => {
    expect(walk(join(ROOT, 'tests')).length).toBeGreaterThan(200);
  });

  it('no test or test helper runs a mutating git command outside tests/helpers/git-env.ts', () => {
    const offenders: string[] = [];
    for (const dir of ['tests', 'apps', 'packages', 'scripts']) {
      for (const f of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, f);
        if (
          rel === 'tests/helpers/git-env.ts' ||
          rel === 'tests/unit/no-unsanitised-git-in-tests.test.ts'
        )
          continue;
        if (runsUnsanitisedMutatingGit(readFileSync(f, 'utf8'))) offenders.push(rel);
      }
    }
    expect(
      offenders,
      'Use initSandboxRepo()/sandboxGit() from tests/helpers/git-env.ts (strips the hook-exported GIT_* env)'
    ).toEqual([]);
  });
});
