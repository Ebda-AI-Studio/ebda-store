/**
 * Which audit findings become tracked issues, and which are already tracked.
 *
 * The scoped-audit gate files P2/P3 findings as GitHub issues. Two defects in
 * that path let the backlog grow to 703 open issues in a single day:
 *
 *  1. The dedup fetched ONE page — `per_page=100`, no pagination — and compared
 *     every new finding against those 100 titles. With 703 open followups that
 *     is 14% of the set, so a finding already tracked on page 2 was filed again.
 *     The `/issues` endpoint also returns pull requests, so some of that single
 *     page was not even issues. Same shape as the audience-resolution defect:
 *     page one is not the set.
 *
 *  2. Nothing capped a run. One PR filed 25 issues, and because the audit runs
 *     on every commit of every PR — including the PRs that fix earlier findings
 *     — each remediation produced its own new followups. 149 were filed on
 *     2026-09-03 against roughly 15 closed.
 *
 * Both are fixed here, as pure functions so the behaviour is testable without
 * a network. Nothing is silently dropped: the PR comment already renders every
 * P2/P3 in full (detail, fix, blast radius), so a finding that is capped out of
 * the issue tracker is still in front of the reviewer on the pull request.
 */

import { fetchAllPages } from './gh-paginate.mjs';

/**
 * Every open audit-followup issue title, across all pages.
 *
 * Stops on the first short page, and refuses to loop forever if the API keeps
 * returning full pages — a runaway here would burn the run's API budget, and a
 * dedup set that is merely very large is still correct enough to file against.
 */
export async function fetchOpenFollowupTitles({ gh, owner, repo, maxPages = 30 }) {
  const { items, complete } = await fetchAllPages({
    gh,
    path: `/repos/${owner}/${repo}/issues?labels=audit-followup&state=open`,
    maxPages,
  });

  const titles = new Set();
  for (const item of items) {
    // `/issues` returns pull requests too; they carry a `pull_request` key.
    if (item && !item.pull_request && typeof item.title === 'string') titles.add(item.title);
  }
  return { titles, complete };
}

/**
 * Severities that become tracked issues.
 *
 * P3 is reported on the pull request and nowhere else. It is not a lesser bug
 * so much as an observation worth a reviewer's attention while they are already
 * looking at the diff, and the record bears that out: across every followup
 * this gate has ever filed, open and closed, not one has been a P0 or a P1 —
 * blocking findings arrive in the PR comment, which stops the merge. A P3 that
 * outlives its review has no reader, and 402 of them were what made a backlog
 * holding nothing urgent read like a crisis.
 *
 * Nothing is lost by the omission: the comment renders every finding in full,
 * detail, fix and blast radius alike.
 */
export const TRACKED_SEVERITIES = new Set(['P0', 'P1', 'P2']);

export function followupIssueTitle(finding) {
  return `[audit-followup][${finding.severity}] ${finding.title || 'untitled'}`;
}

/**
 * Split this run's followups into what to file and what to leave on the PR.
 *
 * Severity orders the queue so a cap spends itself on P2 before P3 — the cap
 * exists to bound volume, not to decide which findings matter.
 */
export function selectFollowupsToFile({
  followups,
  openTitles,
  cap,
  dedupComplete = true,
  trackedSeverities = TRACKED_SEVERITIES,
}) {
  // An incomplete dedup is not evidence that nothing is tracked. Filing against
  // a baseline we could not read is exactly how the same finding gets a second,
  // third and fourth issue — so this run files nothing and leaves every finding
  // to the PR comment, which already carries all of them in full.
  if (!dedupComplete) {
    return {
      toFile: [],
      alreadyTracked: [],
      overCap: [...followups],
      untracked: [],
      dedupIncomplete: true,
    };
  }

  const untracked = followups.filter(f => !trackedSeverities.has(f.severity));
  const ordered = followups
    .filter(f => trackedSeverities.has(f.severity))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const toFile = [];
  const alreadyTracked = [];
  const overCap = [];
  const seenThisRun = new Set();

  for (const f of ordered) {
    const title = followupIssueTitle(f);

    // A single run can produce the same title twice (the same defect reported
    // against two files); filing it twice would defeat the dedup on the NEXT
    // run too, since both copies would then be open.
    if (openTitles.has(title) || seenThisRun.has(title)) {
      alreadyTracked.push(f);
      continue;
    }
    if (toFile.length >= cap) {
      overCap.push(f);
      continue;
    }
    seenThisRun.add(title);
    toFile.push(f);
  }

  return { toFile, alreadyTracked, overCap, untracked, dedupIncomplete: false };
}

function severityRank(severity) {
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return rank[severity] ?? 4;
}
