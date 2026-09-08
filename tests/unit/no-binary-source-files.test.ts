/**
 * No tracked source file may contain a NUL byte.
 *
 * ## Why this is not cosmetic
 *
 * A single NUL anywhere in a file makes git classify it as BINARY, and that
 * has two silent consequences:
 *
 *   1. **Code review cannot see it.** `git diff` renders the whole file as
 *      `Bin 0 -> 14309 bytes` — no hunks, no lines. A reviewer (human, or the
 *      PR-review bot, which is handed the unified diff and nothing else) is
 *      shown nothing at all.
 *   2. **`grep` skips it.** `git grep` and `grep -r` treat a NUL-bearing file
 *      as binary and report no matches, so every blast-radius sweep silently
 *      misses it. A gate that fails open.
 *
 * This is not hypothetical. `tests/integration/export-response-lifecycle.test.ts`
 * shipped in #1596 with a raw NUL used as a join separator in the XLSX
 * assertion. That file exists specifically to prove that PR's "what this does
 * NOT affect" claims — the exports, `orders/*`, `payments/*` — and it was
 * invisible to the review AND to the author's own identifier sweep for the
 * whole life of the PR. The fix was to express the same value as an escape:
 * identical at runtime, and the file is text again.
 *
 * The rule: express the character, never embed the byte.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * The NUL character, BUILT rather than written. Writing it as a literal escape
 * here would be fine for the compiler, but it invites an editor or a codegen
 * step to emit the raw byte instead — which is the exact defect this file
 * guards, and would make THIS file binary and its own gate blind to it.
 */
const NUL = String.fromCharCode(0);

/** Extensions we expect to be human-readable text under review. */
const SOURCE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
  '.scss',
  '.html',
  '.prisma',
  '.sql',
  '.sh',
  '.toml',
]);

function trackedSourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf-8')
    .split(NUL)
    .filter(Boolean);
  return listed.filter(f => SOURCE_EXT.has(path.extname(f)));
}

describe('no tracked source file is binary to git', () => {
  it('contains no NUL bytes (which would hide the file from review AND from grep)', () => {
    const offenders: string[] = [];
    for (const rel of trackedSourceFiles()) {
      let buf: Buffer;
      try {
        buf = fs.readFileSync(path.join(REPO_ROOT, rel));
      } catch {
        continue; // listed by git but absent from the working tree
      }
      const at = buf.indexOf(0);
      if (at !== -1) {
        const line = buf.subarray(0, at).toString('utf-8').split('\n').length;
        offenders.push(`${rel}:${line}`);
      }
    }
    // If this fails: find the raw NUL and express it WITHOUT embedding the
    // byte — a backslash-u escape, or String.fromCharCode(0). Identical at
    // runtime, and the file stays reviewable and greppable.
    expect(offenders).toEqual([]);
  });

  it('is actually scanning a real corpus, and the detector works', () => {
    // A gate that silently scans nothing reports success forever. Two negative
    // controls: the corpus is real and includes the file that motivated this,
    // and the detector fires on a known-bad buffer.
    const files = trackedSourceFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('tests/integration/export-response-lifecycle.test.ts');
    expect(Buffer.from(`join(${NUL})`, 'utf-8').indexOf(0)).toBeGreaterThan(-1);
  });
});
