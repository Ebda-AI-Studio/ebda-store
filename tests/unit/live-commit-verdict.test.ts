/**
 * Whether a deploy actually became live.
 *
 * The case that matters is the first poll. The container answering then is the
 * PREVIOUS release, and one built before `/health` carried a commit reports
 * none at all — so a check that tolerates "unknown" per-poll passes instantly
 * against the old build, every time. That is the exact failure the check exists
 * to catch, and it shipped in the first version of this step.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error - plain .mjs script, no types
import {
  liveCommitVerdict,
  exitCodeFor,
  VERDICT,
  // @ts-expect-error - plain .mjs script, no types
} from '../../.github/scripts/live-commit-verdict.mjs';

const SHA = 'cf6bf66f';
const up = (commit: string | null) => ({ ok: true, commit });
const down = () => ({ ok: false, commit: null });

describe('an unknown commit must not pass on the first poll', () => {
  it('does not call it live when the old build simply names nothing', () => {
    // The regression, stated directly: previous release answers 200 with no
    // commit on attempt 1, the new build appears later and never gets looked at.
    const v = liveCommitVerdict([up(null)], SHA);
    expect(v, 'passing here reports success against the previous release').toBe(VERDICT.UNKNOWN);
  });

  it('finds the deployed commit when it appears after several silent polls', () => {
    const v = liveCommitVerdict([up(null), up(null), up(null), up(SHA)], SHA);
    expect(v).toBe(VERDICT.LIVE);
  });

  it('finds it after the service was briefly unreachable mid-roll', () => {
    const v = liveCommitVerdict([up(null), down(), down(), up(SHA)], SHA);
    expect(v).toBe(VERDICT.LIVE);
  });
});

describe('a commit that is not ours means the deploy did not take', () => {
  it('is stale when another build answers throughout', () => {
    const v = liveCommitVerdict([up('0ldbu1ld'), up('0ldbu1ld')], SHA);
    expect(v).toBe(VERDICT.STALE);
    expect(exitCodeFor(v)).toBe(1);
  });

  it('is still live if ours shows up after the old one', () => {
    const v = liveCommitVerdict([up('0ldbu1ld'), up(SHA)], SHA);
    expect(v).toBe(VERDICT.LIVE);
  });

  it('a match is conclusive even if a later poll hits an older replica', () => {
    // Mid-rollout both replicas serve. Having seen ours once is enough.
    const v = liveCommitVerdict([up(SHA), up('0ldbu1ld')], SHA);
    expect(v).toBe(VERDICT.LIVE);
  });
});

describe('unreachable is not the same as unknown', () => {
  it('is stale when nothing ever answered', () => {
    expect(liveCommitVerdict([down(), down()], SHA)).toBe(VERDICT.STALE);
    expect(liveCommitVerdict([], SHA)).toBe(VERDICT.STALE);
  });

  it('ignores a commit reported on a non-200', () => {
    expect(liveCommitVerdict([{ ok: false, commit: SHA }], SHA)).toBe(VERDICT.STALE);
  });
});

describe('exit codes', () => {
  it('unknown passes — not knowing is not failing', () => {
    expect(exitCodeFor(VERDICT.UNKNOWN)).toBe(0);
  });

  it('live passes, stale fails', () => {
    expect(exitCodeFor(VERDICT.LIVE)).toBe(0);
    expect(exitCodeFor(VERDICT.STALE)).toBe(1);
  });
});

describe('an answer we could not read is not an answer', () => {
  // The shell used `python3 ... 2>/dev/null || echo ''`, so a missing
  // interpreter, an HTML error page and a genuine `commit: null` all became the
  // same empty string — and empty was tolerated. A broken parser therefore
  // passed every deploy, permanently, reinstating the exact failure the check
  // exists to prevent one level down.
  const unreadable = () => ({ ok: true, commit: null, unreadable: true });

  it('does not pass when every reachable poll was unparseable', () => {
    const v = liveCommitVerdict([unreadable(), unreadable()], SHA);
    expect(v).toBe(VERDICT.UNREADABLE);
    expect(exitCodeFor(v), 'a broken check must not report success').toBe(1);
  });

  it('still passes if the deployed commit is readable at some point', () => {
    const v = liveCommitVerdict([unreadable(), up(SHA)], SHA);
    expect(v).toBe(VERDICT.LIVE);
  });

  it('keeps unreadable distinct from a build that simply names nothing', () => {
    expect(liveCommitVerdict([up(null)], SHA)).toBe(VERDICT.UNKNOWN);
    expect(liveCommitVerdict([unreadable()], SHA)).toBe(VERDICT.UNREADABLE);
    expect(exitCodeFor(VERDICT.UNKNOWN)).toBe(0);
    expect(exitCodeFor(VERDICT.UNREADABLE)).toBe(1);
  });

  it('a real mismatch still outranks an unreadable poll', () => {
    // Someone else is demonstrably serving: that is stale, not merely unread.
    expect(liveCommitVerdict([unreadable(), up('0ldbu1ld')], SHA)).toBe(VERDICT.STALE);
  });
});

describe('the workflow captures the parser status instead of dying on it', () => {
  // GitHub Actions runs `run:` blocks under `bash -e`. A bare assignment from a
  // command substitution inherits that command's exit status, so the parser's
  // `exit 3` terminated the STEP: no observation recorded, the verdict script
  // never reached, and UNREADABLE unreachable in production — the whole point
  // of the check, silently disabled. The retry window collapsed to one poll
  // too, so a single transient failed a healthy deploy.
  //
  // Asserted structurally because the failure is in shell semantics, not in
  // any function this suite can call.
  const workflow = readFileSync(
    new URL('../../.github/workflows/railway-deploy.yml', import.meta.url),
    'utf8'
  );

  it('guards the parser capture so errexit cannot kill the step', () => {
    const line = workflow.split('\n').find(l => l.includes('live=$(printf'));
    expect(line, 'the parser capture line has moved or been renamed').toBeDefined();
    expect(
      line,
      "a bare assignment inherits node's exit 3 under bash -e and terminates the step"
    ).toMatch(/\|\|\s*parse_rc=\$\?/);
  });

  it('resets the status before each attempt', () => {
    // Without this, a success after a failure would carry the previous
    // iteration's non-zero status and report a readable body as unreadable.
    expect(workflow).toMatch(/parse_rc=0\s*\n\s*live=\$\(printf/);
  });

  it('every command substitution in the verify step tolerates failure', () => {
    const step = workflow.slice(
      workflow.indexOf('Verify the deployed build is THIS commit'),
      workflow.indexOf('notify-failure:')
    );
    const assignments = step.split('\n').filter(l => /^\s+[a-z_]+=\$\(/.test(l));
    expect(assignments.length).toBeGreaterThanOrEqual(3);
    for (const a of assignments) {
      expect(a, `unguarded substitution under bash -e: ${a.trim().slice(0, 60)}`).toMatch(/\|\|/);
    }
  });

  it('#1519: body and code come from ONE request, not two independent curls', () => {
    const step = workflow.slice(
      workflow.indexOf('Verify the deployed build is THIS commit'),
      workflow.indexOf('Verify guest checkout is still admitted')
    );
    const curlCalls = step.match(/curl\s/g) ?? [];
    expect(
      curlCalls.length,
      'more than one curl call per poll reintroduces the two-request race ' +
        '(a body fetched at one instant, a status code fetched moments ' +
        'later) that let a perfectly healthy poll read as UNREADABLE'
    ).toBe(1);
    // The single curl must emit BOTH the body and the status code, and code/
    // body must both be derived from that same captured response.
    expect(step).toMatch(/curl\s+-s[^\n]*-w\s+'\\n%\{http_code\}'/);
    expect(step).toMatch(/code="\$\(printf '%s' "\$resp"/);
    expect(step).toMatch(/body="\$\(printf '%s' "\$resp"/);
  });
});
