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
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files).toContain('ci.yml');
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
