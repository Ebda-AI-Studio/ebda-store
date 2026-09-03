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
