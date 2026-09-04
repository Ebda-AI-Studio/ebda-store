/**
 * What exit code does the gate deserve when the model never ran?
 *
 * The gate fails OPEN on purpose: a broken or rate-limited model must not block
 * every pull request on a repo with no second human reviewer. That reasoning is
 * sound and is not changed here.
 *
 * What was wrong is the SIGNAL, not the policy. Exiting zero renders the check
 * green, and green is the one thing a merge decision actually reads — so a run
 * that audited nothing was indistinguishable from one that audited everything
 * and approved it. The alert the non-run does raise goes to a step summary and
 * a comment, neither of which is in front of anyone at the moment they merge.
 * Observed 2026-09-03: `claude CLI exited 1 — the scoped-audit gate did not run
 * for this PR`, `AUDIT_RAN: false`, check reported `completed/success`.
 *
 * A non-zero exit costs nothing here because **this gate is not a required
 * check**. Branch protection lists eleven required checks and this is not among
 * them, so a red tick informs without blocking — fail-open in the sense that
 * matters (the merge is still possible) while being honest in the sense that
 * was missing (it does not claim to have passed).
 *
 * If this ever becomes a required check, this policy has to be revisited in the
 * same change — at that point a red tick WOULD block, and the trade-off the
 * file header describes would silently invert.
 */

/** Why a run produced nothing to gate on. */
export const NON_RUN_REASONS = Object.freeze({
  SENTINEL: 'sentinel', // the workflow told us the model never ran
  UNREADABLE: 'unreadable', // output existed but could not be read
  EMPTY: 'empty', // output read but carried no result
  // Pre-flight: the gate could not even begin. Kept in the same enum so this
  // stays the enumeration of record — a reason that lives only at its call site
  // is a reason the next reader will not know to look for.
  NO_GITHUB_TOKEN: 'no-github-token',
  NO_REPOSITORY: 'no-repository',
  NO_PR_NUMBER: 'no-pr-number',
});

/**
 * @returns the process exit code for a run that produced no findings to gate on
 */
export function nonRunExitCode({ isRequiredCheck = false } = {}) {
  // Required would mean blocking, which the fail-open policy forbids.
  return isRequiredCheck ? 0 : 1;
}

/** Exit code for a completed audit, given whether it found anything blocking. */
export function auditExitCode({ blockingFindings }) {
  return blockingFindings > 0 ? 1 : 0;
}
