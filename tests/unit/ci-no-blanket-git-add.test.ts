/**
 * No CI job may stage with a blanket `git add -A` / `git add .`.
 *
 * The standing rule (CLAUDE.md) is "git add specific paths, never -A/." because
 * a blanket add sweeps whatever else is in the workspace: nested repos, local
 * scratch, a stray `.env.local`, anything a tool dropped. In CI that is worse
 * than locally — nobody is watching the staging area, and the commit is pushed
 * automatically.
 *
 * `ai-review.yml`'s auto-fix job was the one place it survived. It now stages
 * `git add -u` (tracked modifications — what the fix actually changed) plus an
 * explicit, logged list of new files under known source paths.
 *
 * The second assertion is about a different defect the same job had: a GitHub
 * App token cannot write under `.github/workflows/` without the `workflows`
 * permission, and `AI_FIX_PAT` does not have it. One workflow-file edit made
 * the ENTIRE push fail, taking every other fix in the commit with it, and
 * reported only "Process completed with exit code 1" (measured on PR #1720).
 * The job must now drop the workflow portion, push the rest, and say so.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WF_DIR = join(__dirname, '../../.github/workflows');

/** Strip `#` comments so the gate does not match its own prose (defect #1678's class). */
function code(src: string): string {
  return src
    .split('\n')
    .map(l => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

const files = readdirSync(WF_DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('CI jobs never stage with a blanket git add', () => {
  it('found the workflows (guards against an empty-set pass)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain('ai-review.yml');
  });

  it.each(files)('%s', file => {
    const src = code(readFileSync(join(WF_DIR, file), 'utf8'));
    const hits = [...src.matchAll(/git\s+add\s+(-A\b|\.\s*$|\.\s)/gm)].map(m => m[0].trim());
    expect(
      hits,
      `${file} stages with a blanket add (${hits.join(', ')}). Use \`git add -u\` for ` +
        `tracked changes plus an explicit list of new files — a blanket add in CI ` +
        `sweeps untracked files nobody is watching for.`
    ).toEqual([]);
  });
});

describe('ai-review auto-fix survives a workflow-file edit', () => {
  const src = readFileSync(join(WF_DIR, 'ai-review.yml'), 'utf8');

  it('ATTEMPTS the real push before assuming anything about the token', () => {
    // The `workflows` permission is a property of AI_FIX_PAT — invisible from
    // inside the job and changeable without touching this file. An earlier
    // version pre-emptively reverted every workflow edit on the assumption the
    // scope was missing, which would permanently stop the bot repairing a
    // workflow the day the scope is granted. Try, then react.
    const attemptAt = src.indexOf('if git push "$REMOTE"');
    const restoreAt = src.indexOf('git restore --staged --worktree');
    expect(attemptAt, 'no real push attempt').toBeGreaterThan(-1);
    expect(restoreAt, 'no fallback').toBeGreaterThan(-1);
    expect(attemptAt, 'the fallback must come AFTER the attempt').toBeLessThan(restoreAt);

    // The ordering check alone is not enough: re-adding a DIFFERENT revert
    // (`git checkout --`) before the push leaves it green while restoring the
    // exact behaviour this test exists to prevent. Verified — that mutation
    // passed until this assertion was added. So: NOTHING may discard a
    // workflow edit before the push is attempted.
    const beforePush = src.slice(0, attemptAt);
    expect(
      /git checkout --|git restore/.test(beforePush),
      'a workflow edit is discarded BEFORE the push is attempted — the bot can ' +
        'then never fix a workflow file, even once AI_FIX_PAT has the scope'
    ).toBe(false);
  });

  it('falls back ONLY on the workflows-permission rejection', () => {
    // A protected branch, an auth failure or a non-fast-forward must stay red.
    // Retrying those into a partial push would hide a real failure.
    expect(src).toMatch(/grep -qE .*workflows?.*permission\|scope/);
    expect(src).toMatch(/rejected for a reason other than the workflows permission/);
  });

  it('#1769: recognises BOTH the GitHub App and classic-PAT rejection wording', () => {
    // GitHub words this rejection differently by token type: a GitHub App /
    // fine-grained PAT says "without `workflows` permission" (plural), a
    // classic PAT/OAuth App says "without `workflow` scope" (singular).
    // Matching only the first treated a classic-PAT AI_FIX_PAT's identical,
    // recoverable rejection as an unrecoverable failure.
    const grepLine = src.split('\n').find(l => l.includes('grep -qE') && l.includes('workflow'));
    expect(grepLine, 'grep line not found').toBeTruthy();
    const m = grepLine!.match(/grep -qE "([^"]+)"/);
    expect(m, 'could not extract the grep pattern').toBeTruthy();
    const re = new RegExp(m![1]);
    expect(
      re.test('refused (403) creating or updating workflow file without `workflows` permission')
    ).toBe(true);
    expect(
      re.test('refused (403) creating or updating workflow file without `workflow` scope')
    ).toBe(true);
    expect(re.test('protected branch hook declined')).toBe(false);
  });

  it('#1757/#1758/#1768: WF_CHANGED counts only TRACKED workflow edits, and new-file staging is unrestricted', () => {
    // WF_CHANGED must never include a path that was never staged: `git
    // restore --staged --worktree` on such a path fails with "pathspec did
    // not match any file(s) known to git" (verified in a scratch repo)
    // instead of the graceful drop the fallback performs for every other
    // case. `git status --porcelain` codes a tracked change (" M") and a
    // brand-new untracked file ("??") identically once piped through `awk
    // '{print $2}'`, so this must filter untracked paths out explicitly
    // (see tests/unit/ai-review-autofix-file-staging.test.ts for the
    // end-to-end proof against a real git repo — this test only pins the
    // shape of the guard, not its exact command).
    const wfChangedLine = src.split('\n').find(l => l.trim().startsWith('WF_CHANGED="$('));
    expect(wfChangedLine, 'WF_CHANGED assignment not found').toBeTruthy();
    expect(wfChangedLine).toMatch(/grep -v '\^\?\?'/);

    // NEW_FILES must not be restricted to a hardcoded path allowlist: the
    // auto-fix's allowedTools are not scoped to apps/packages/tests/docs/
    // scripts/.zap, so a new file created outside those roots (.github/,
    // .husky/, a new root config) was silently neither staged nor logged.
    // It must also exclude new workflow files specifically — those are
    // reported separately (WF_NEW) and can never be pushed by this token.
    // The pathspec lives in NEW_FILES_PATHSPEC since issue 2102 (a denylist
    // of scratch shapes alongside the workflow exclusion).
    const newFilesLine = src.split('\n').find(l => l.includes('git ls-files --others'));
    expect(newFilesLine, 'NEW_FILES line not found').toBeTruthy();
    expect(newFilesLine).not.toMatch(/-- apps packages tests docs scripts \.zap/);
    const specLine = src.split('\n').find(l => l.trim().startsWith('NEW_FILES_PATHSPEC=('));
    expect(specLine, 'NEW_FILES_PATHSPEC not found').toBeTruthy();
    expect(specLine).toMatch(/:\((?:exclude)[^)]*\)\.github\/workflows/);
    expect(specLine).not.toMatch(/ apps packages tests docs scripts \.zap/);

    // WF_CHANGED/WF_NEW must be computed BEFORE `git add -u`, so a
    // subsequent `git status --porcelain` read of the same paths (used by
    // the fallback restore below) still sees the pre-stage picture.
    const wfAt = src.indexOf('WF_CHANGED="$(git status --porcelain');
    const addUAt = src.indexOf('git add -u');
    expect(wfAt, 'WF_CHANGED computation not found').toBeGreaterThan(-1);
    expect(addUAt, 'git add -u not found').toBeGreaterThan(-1);
    expect(wfAt, 'WF_CHANGED must be read BEFORE git add -u').toBeLessThan(addUAt);
  });

  it('preserves the non-workflow half of the fix when it does fall back', () => {
    expect(src).toMatch(/git reset --soft HEAD~1/);
    expect(src).toMatch(/git commit -m "fix: address AI-review critical findings/);
  });

  it('still fails the job when ONLY workflow files changed', () => {
    // Otherwise a fix that touched nothing else reports success having pushed
    // nothing.
    expect(src).toMatch(/touched ONLY workflow files/);
    expect(src).toMatch(/git diff --cached --quiet/);
  });

  it('names the missing permission so the fix is actionable', () => {
    expect(src).toMatch(/::warning::.*workflows.* permission/i);
    expect(src).toMatch(/Grant the .workflows. permission to AI_FIX_PAT/);
  });
});
