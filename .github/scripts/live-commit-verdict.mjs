/**
 * Did the build we just deployed actually become the live one?
 *
 * The first version of this decided per-poll, and got it exactly backwards on
 * the attempt that matters. It tolerated an unknown commit by passing
 * immediately — but the container answering on the first poll is the PREVIOUS
 * release, and a release built before this field existed reports no commit at
 * all. So the tolerance fired on attempt one, every time, and reported success
 * against the old build: the precise "green tick on a deploy that never
 * landed" the check was written to eliminate.
 *
 * The bug was in treating one observation as a verdict. Absence of evidence
 * arrives instantly; evidence arrives only after the deploy rolls. So a verdict
 * is only reachable from the WHOLE window: a match can be trusted the moment it
 * appears, while an unknown means nothing until nothing else has shown up
 * either.
 */

/** @typedef {{ ok: boolean, commit: string|null }} Observation */

export const VERDICT = Object.freeze({
  LIVE: 'live', // the deployed commit is answering
  UNKNOWN: 'unknown', // reachable, but no build would name itself
  STALE: 'stale', // something else is answering, or nothing is
});

/**
 * @param {Observation[]} observations in poll order
 * @param {string} expectedSha the commit being deployed
 */
export function liveCommitVerdict(observations, expectedSha) {
  let sawReachable = false;
  let sawOtherCommit = false;

  for (const o of observations) {
    if (!o || !o.ok) continue;
    sawReachable = true;

    // A match is conclusive the moment it appears — nothing later can unmake it.
    if (o.commit && o.commit === expectedSha) return VERDICT.LIVE;

    if (o.commit) sawOtherCommit = true;
  }

  // Never answered at all.
  if (!sawReachable) return VERDICT.STALE;

  // Something named a commit and it was never ours: the deploy did not take.
  if (sawOtherCommit) return VERDICT.STALE;

  // Reachable throughout, and no build ever named itself. Genuinely unknown —
  // which is not the same as wrong, and must not be reported as failure.
  return VERDICT.UNKNOWN;
}

/** Exit code for a verdict. UNKNOWN passes: not knowing is not failing. */
export function exitCodeFor(verdict) {
  return verdict === VERDICT.STALE ? 1 : 0;
}
