# Scoped Audit — followup issue dedup

> Audience: whoever triages the `audit-followup` label or is asked "why did
> the scoped-audit gate file a duplicate issue?"

## What dedups against what

The gate (`.github/scoped-audit/audit.mjs` + `followup-filing.mjs`) files
P2 findings as GitHub issues labelled `audit-followup`, and comments P3s only
on the PR. Two keys are checked before a finding becomes a new issue:

1. **Title** — exact string match against every open `audit-followup` issue's
   title.
2. **Location fingerprint** — a hidden `<!-- audit-fp:dimension|file -->`
   marker embedded in the issue body (not rendered by GitHub), matched
   against the same marker on a new finding at the same dimension + file. This
   is what lets a finding the model rewords between pushes still resolve to
   the issue that already tracks it, instead of opening a second one (#116).

A location match does not silently drop the reworded finding: it is posted as
a comment on the existing issue instead (`toComment`, capped at
`MAX_COMMENTS_PER_RUN` per run — see `audit.mjs`), so two genuinely different
defects at one file are never collapsed into invisibility.

## Issues filed with the old `dimension|file|line` key DO dedup

The key was `dimension|file|line` until #1738 dropped the line (a model's
"approx line N" guess is the least stable part of a finding). When it
changed, 195 of the 200 open `audit-followup` issues carried the three-part
marker. `extractFingerprint` normalises a legacy marker to its first two
segments (`normalizeFingerprint` in `followup-filing.mjs`), so those issues
match the current key and are commented on rather than filed again.

One bounded residual: a **location comment** already posted on an issue under
the old key carries an `audit-cmt:dimension|file|line|pr-N` marker, which the
new `dimension|file|pr-N` marker does not match. The first run per (issue, PR)
after the change posts one new comment instead of editing the old one; every
later run edits the new one. That is at most one extra comment per pair, not
growth.

## The one-time gap: pre-marker issues don't retroactively dedup

**The location fingerprint only dedupes issues filed AFTER it shipped.** Every
`audit-followup` issue filed before the marker existed has no
`<!-- audit-fp:... -->` in its body — `extractFingerprint` returns `null` for
all of them — so they fall through to title-only dedup like before. As of the
marker shipping, the open `audit-followup` backlog does not benefit from the
fix; a reworded finding at one of those locations can still be filed again
until it happens to hit the title match, or until the fingerprint is added.

**No backfill has been run.** Two ways to close this gap, neither done here:

- **Bulk-close** the pre-marker backlog and let the gate re-file (now
  fingerprinted) anything still live.
- **Backfill markers** into existing open issues by parsing each issue's
  `**Location:**` line (rendered by `audit.mjs`, e.g.
  `` `apps/api/src/services/order.service.ts:412` ``) and appending the
  equivalent `<!-- audit-fp:dimension|file -->` marker via the GitHub API.
  Reading the dedup key back off the same `**Dimension:**` /`**Location:**`
  lines the issue body already renders keeps it a one-off script rather than a
  new code path.

Until one of these runs, treat a duplicate-looking `audit-followup` issue
filed against a pre-marker location as expected, not a regression.

## A truncated audit reports PARTIAL, never PASSED

On a large diff the model's response can be cut off mid-JSON.
`partial-json.mjs` recovers the findings written before the cutoff, and the
gate keeps them — recovered P2s are still filed here. But the part of the diff
after the cutoff was never reviewed, so the comment header reads
`Scoped Audit — PARTIAL` and, when nothing blocking was recovered, the check
exits with the non-run code from `gate-policy.mjs` (red, informational, not a
required check) instead of 0. A recovered P0/P1 still reads BLOCKED and exits

1. Before this, a truncated review rendered `PASSED` and a green tick on
   exactly the largest PRs (scoped audit, PR 1978).

## Location comments are size-capped and their writes are checked (issue 2206)

A location comment carries every finding grouped at one location. It is capped
at `LOCATION_COMMENT_MAX_CHARS` (60,000, under GitHub's 65,536 limit) by
`buildLocationCommentBody` in `followup-filing.mjs`; an over-long body is cut
with a visible "truncated" note and always keeps its upsert marker. Both the
PATCH and the POST now check the response: a rejected write logs a
`::warning::` naming the issue and HTTP status instead of claiming success. The
PR comment still carries every finding in full either way.

## Dependabot PRs are not audited (issue 2254)

`scoped-audit.yml` and `ai-review.yml` skip PRs authored by `dependabot[bot]`
(the weekly github-actions bumps from `.github/dependabot.yml`). A
Dependabot-triggered run has no `CLAUDE_CODE_OAUTH_TOKEN` and a read-only
`GITHUB_TOKEN`, so the audit could only ever take its did-not-run path: a red
tick and a false "scoped-audit did not run" Telegram alert every week. A
skipped job reports as success, so a "did not run" alert still means a real
failure on a PR the gate should have audited.
