/**
 * Issue 2454 — the required "Scan for leaked secrets" check must never end `cancelled` on a main
 * commit. `cancel-in-progress: false` alone does not do it: GitHub keeps at most ONE pending run per
 * concurrency group, so a second merge to main cancelled the earlier, still-pending main run before
 * it scanned. A push therefore needs a group of its own (keyed by sha); only a pull_request run may
 * be cancelled (a newer sha supersedes it).
 *
 * Mutation-proof: restoring `group: gitleaks-${{ github.ref }}` reddens the first case; making
 * `cancel-in-progress` unconditional reddens the second.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, '../../.github/workflows/gitleaks.yml'), 'utf8');
const group = src.match(/^ {2}group: (.+)$/m)?.[1] ?? '';
const cancel = src.match(/^ {2}cancel-in-progress: (.+)$/m)?.[1] ?? '';

describe('gitleaks.yml concurrency (issue 2454)', () => {
  it('a push to main has its own group keyed by the commit sha', () => {
    expect(group).toMatch(/github\.event_name == 'push' && github\.sha/);
    // The non-push arm (PR, dispatch) still groups by ref so a superseded PR push is cancelled.
    expect(group).toMatch(/\|\| github\.ref/);
  });

  it('only a pull_request run is cancellable', () => {
    expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it('the comment no longer claims the pending-state invariant it could not keep', () => {
    expect(src).toMatch(/at most\s+# ONE pending run per group/);
  });
});
