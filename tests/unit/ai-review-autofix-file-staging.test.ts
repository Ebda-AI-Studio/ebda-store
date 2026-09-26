/**
 * The AI auto-fix step's file-staging logic, exercised against a real git
 * repo rather than read as text — these are shell one-liners, and the two
 * defects they carry (#1758, #1768) are both about what a real `git status`
 * mix of tracked/untracked/new-path-shape input produces, not something a
 * string match on the workflow YAML could catch.
 *
 * #1758: NEW_FILES named exactly six roots (apps packages tests docs scripts
 * .zap), so a new file anywhere else — .github/ai-review/*.mjs, .husky/**,
 * a new root config — was silently never staged.
 *
 * #1768: WF_CHANGED read `git status --porcelain`, which codes a tracked
 * change (" M") and a brand-new untracked file ("??") identically once piped
 * through `awk '{print $2}'`. A new workflow file was never staged (NEW_FILES
 * excludes .github/workflows/**), so including it in WF_CHANGED made the
 * later `git restore --staged --worktree -- $WF_CHANGED` fail on a path git
 * never staged, aborting the whole restore atomically and losing the
 * already-staged non-workflow fix with it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/ai-review.yml'), 'utf8');

/** Pull the exact `VAR="$(...)"` assignment line for `name` out of the workflow. */
function extractAssignment(name: string): string {
  const line = WORKFLOW.split('\n').find(l => l.trim().startsWith(`${name}="$(`));
  expect(line, `${name} assignment moved in ai-review.yml — re-point this test`).toBeTruthy();
  return line!.trim();
}

// Strip GIT_DIR/GIT_WORK_TREE/etc — when this suite runs FROM a git hook
// (the pre-push hook's own vitest run), git already exported those into the
// process env for the OUTER repo, and they leak into every child `git`
// invocation below, pointing it at the outer repo instead of the scratch
// one this test just initialized ("fatal: this operation must be run in a
// work tree"). A plain `npx vitest` invocation has none of these set, which
// is why this only reproduced under the hook.
const CLEAN_GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_GIT_ENV });
}

/** Run the real shell assignment lines against a scratch repo and read the vars back. */
function runStagingLogic(cwd: string): {
  wfChanged: string[];
  wfNew: string[];
  newFiles: string[];
} {
  const script = [
    '#!/bin/bash',
    'set -euo pipefail',
    extractAssignment('WF_CHANGED'),
    extractAssignment('WF_NEW'),
    'git add -u',
    extractAssignment('NEW_FILES'),
    'if [ -n "$NEW_FILES" ]; then echo "$NEW_FILES" | xargs -r git add --; fi',
    'printf "WF_CHANGED_START\\n%s\\nWF_CHANGED_END\\n" "$WF_CHANGED"',
    'printf "WF_NEW_START\\n%s\\nWF_NEW_END\\n" "$WF_NEW"',
    'printf "NEW_FILES_START\\n%s\\nNEW_FILES_END\\n" "$NEW_FILES"',
  ].join('\n');
  const scriptPath = path.join(cwd, '__staging.sh');
  writeFileSync(scriptPath, script);
  const out = execFileSync('bash', [scriptPath], { cwd, encoding: 'utf8', env: CLEAN_GIT_ENV });
  const section = (name: string) =>
    (out.match(new RegExp(`${name}_START\\n([\\s\\S]*?)\\n${name}_END`)) ?? ['', ''])[1]
      .split('\n')
      .filter(Boolean);
  return {
    wfChanged: section('WF_CHANGED'),
    wfNew: section('WF_NEW'),
    newFiles: section('NEW_FILES'),
  };
}

describe('ai-review auto-fix file staging (#1758, #1768)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ai-review-autofix-'));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(dir, '.github/ai-review'), { recursive: true });
    mkdirSync(path.join(dir, 'apps'), { recursive: true });
    writeFileSync(path.join(dir, 'apps/tracked.ts'), 'x');
    writeFileSync(path.join(dir, '.github/workflows/existing.yml'), 'a: 1\n');
    writeFileSync(path.join(dir, '.github/ai-review/prompt.md'), 'p');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stages a new file OUTSIDE the old six hardcoded roots (#1758)', () => {
    // The regression: a new file under .github/ai-review (not apps/packages/
    // tests/docs/scripts/.zap) used to be silently dropped.
    writeFileSync(path.join(dir, '.github/ai-review/new-helper.mjs'), 'export default 1;\n');
    writeFileSync(path.join(dir, 'root-config.json'), '{}\n');
    const { newFiles } = runStagingLogic(dir);
    expect(newFiles).toContain('.github/ai-review/new-helper.mjs');
    expect(newFiles).toContain('root-config.json');
    // And it is actually staged, not just named.
    const staged = git(dir, 'diff', '--cached', '--name-only').trim().split('\n');
    expect(staged).toContain('.github/ai-review/new-helper.mjs');
    expect(staged).toContain('root-config.json');
  });

  it('never stages a NEW workflow file, but warns about it separately (#1758/#1768)', () => {
    writeFileSync(path.join(dir, '.github/workflows/new.yml'), 'b: 2\n');
    const { newFiles, wfNew, wfChanged } = runStagingLogic(dir);
    expect(newFiles).not.toContain('.github/workflows/new.yml');
    expect(wfNew).toContain('.github/workflows/new.yml');
    // It was never staged, so it must not appear in the tracked-only list —
    // that is exactly the list #1768's `git restore --staged` call consumes.
    expect(wfChanged).not.toContain('.github/workflows/new.yml');
    const staged = git(dir, 'diff', '--cached', '--name-only').trim();
    expect(staged.split('\n')).not.toContain('.github/workflows/new.yml');
  });

  it('WF_CHANGED contains only tracked, already-staged workflow edits (#1768)', () => {
    appendFileSync(path.join(dir, '.github/workflows/existing.yml'), 'c: 3\n');
    writeFileSync(path.join(dir, '.github/workflows/brand-new.yml'), 'd: 4\n');
    const { wfChanged, wfNew } = runStagingLogic(dir);
    expect(wfChanged).toEqual(['.github/workflows/existing.yml']);
    expect(wfNew).toEqual(['.github/workflows/brand-new.yml']);

    // The bug this pins: every path WF_CHANGED lists must already be staged,
    // so the later `git restore --staged --worktree -- $WF_CHANGED` (used
    // when AI_FIX_PAT lacks the workflows permission) never hits an
    // untracked path and aborts. Reproduce that exact call here.
    for (const f of wfChanged) {
      git(dir, 'restore', '--staged', '--worktree', '--', f);
    }
    // No throw = the fix holds. Also confirm it actually restored (unstaged
    // the tracked edit) rather than a no-op.
    const staged = git(dir, 'diff', '--cached', '--name-only').trim();
    expect(staged).not.toContain('.github/workflows/existing.yml');
  });
});
