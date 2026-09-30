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
 *  3. The dedup key was the ISSUE TITLE, and the title embeds `finding.title` —
 *     free text a model produces non-deterministically. The gate runs on every
 *     push to a PR, so the same underlying defect, phrased slightly differently
 *     on the next run, missed the exact-match check and was filed again. Filed
 *     as #116 on the day the gate shipped and left open ever since; by
 *     2026-09-11 there were 929 open followups across 315 files.
 *
 *     Fixed by fingerprinting the LOCATION — dimension + file — into a hidden
 *     marker in the issue body, and matching on that. A reworded finding now
 *     resolves to the issue that already tracks it. `line` is deliberately NOT
 *     part of the key: prompt.md explicitly allows the model to cite an
 *     "approx line N" when unsure, and the file under review keeps changing
 *     between pushes (that is why there was a push), so a line number — exact
 *     or estimated — is the least stable part of a finding's identity. Filed
 *     as #1738 after `dimension|file|line` was observed drifting the key on
 *     every push to a file it did not close.
 *
 *     The failure mode of a coarser key is the opposite one: two genuinely
 *     different defects in the same file would collapse into one issue and the
 *     second would vanish. So a fingerprint match does NOT silently drop the
 *     finding — it returns it as `toComment`, and the caller posts it on the
 *     existing issue. Nothing is lost either way, which is the property worth
 *     more than either key being perfect.
 *
 *  4. That `toComment` path was itself unbounded. It is reached precisely when a
 *     defect persists and the model rewords it, and the gate runs on EVERY push
 *     to a PR — so a persistent finding lands there on every push, and posting
 *     unconditionally would have replaced 929 duplicate ISSUES with one
 *     duplicate COMMENT per push per issue, forever. The same growth, moved one
 *     level down.
 *
 *     So a location comment carries its own hidden marker, keyed on the
 *     location AND the pull request — not on the title (the free text that
 *     rewords) and not on the commit (which changes on every push, i.e. exactly
 *     the key that would reproduce the bug). The caller UPSERTS against it: one
 *     comment per location per PR, edited in place as the wording changes,
 *     the same shape as the gate's own PR marker comment. `selectFollowupsToFile`
 *     also caps how many `toComment` entries one run may produce (`commentCap`,
 *     same default as the issue-filing cap) — filed as #1752 after a run with
 *     many already-tracked locations issued one paginated read plus one write
 *     per location with no bound at all. Overflow goes to `overCap`, same as an
 *     over-cap new issue — nothing is lost, the PR comment still carries it.
 *
 * All four are fixed here, as pure functions so the behaviour is testable
 * without a network. Nothing is silently dropped: the PR comment already renders every
 * P2/P3 in full (detail, fix, blast radius), so a finding that is capped out of
 * the issue tracker is still in front of the reviewer on the pull request.
 *
 * Caveat (#1745): the location fingerprint only dedupes issues filed AFTER it
 * shipped. Every `audit-followup` issue filed before this marker existed has no
 * `<!-- audit-fp:... -->` in its body, so `extractFingerprint` returns null for
 * all of them and they fall through to title-only dedup — the backlog does not
 * retroactively benefit. No backfill has been run; see
 * `docs/runbooks/scoped-audit-followups.md`.
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
  // fingerprint -> issue number, so a reworded finding can be commented onto
  // the issue that already tracks it rather than filed again.
  const fingerprints = new Map();
  for (const item of items) {
    // `/issues` returns pull requests too; they carry a `pull_request` key.
    if (!item || item.pull_request) continue;
    if (typeof item.title === 'string') titles.add(item.title);
    const fp = extractFingerprint(item.body);
    // First writer wins: if two issues somehow share a fingerprint, comments
    // go to the older one, which is the one a human is more likely watching.
    if (fp && !fingerprints.has(fp)) fingerprints.set(fp, item.number);
  }
  return { titles, fingerprints, complete };
}

/** Hidden marker carrying the location fingerprint. Never rendered by GitHub. */
export const FINGERPRINT_PREFIX = 'audit-fp:';

/**
 * A stable identity for a finding: what kind of problem, in which file.
 * Deliberately NOT the title — that is the free text a model rewords between
 * runs, which is the whole defect this exists to close — and deliberately NOT
 * the line: prompt.md permits an "approx line N" guess, and a persistent
 * finding is reported on a file that keeps moving between pushes (that is why
 * there was a push), so a line number is the least stable part of a finding's
 * identity (#1738). Two genuinely different findings in one file now share a
 * fingerprint and travel together in `toComment` instead of missing dedup
 * and each opening its own issue — `groupCommentsByIssue` keeps both visible
 * in one comment, so nothing is lost by the coarser key.
 */
export function followupFingerprint(finding) {
  // No file means no location, and a location key over "unknown" would make
  // EVERY location-less finding the same finding — collapsing unrelated
  // defects into one issue and silently discarding the rest. That is the exact
  // failure this whole mechanism is supposed to avoid, so a finding without a
  // file gets NO fingerprint and falls back to title dedup alone.
  const file = typeof finding?.file === 'string' ? finding.file.trim() : '';
  if (!file || file === '(unknown)') return null;
  const dimension = String(finding?.dimension || 'audit')
    .trim()
    .toLowerCase();
  return `${dimension}|${file}`;
}

/** The marker line to embed in an issue body. */
export function fingerprintMarker(finding) {
  const fp = followupFingerprint(finding);
  return fp ? `<!-- ${FINGERPRINT_PREFIX}${fp} -->` : '';
}

/**
 * Read a fingerprint back out of an issue body, or null if it has none.
 *
 * Matches the LAST marker, not the first (#1744). The issue body interpolates
 * three blocks of model-authored free text (detail/fix/blastRadius) BEFORE the
 * real marker this module appends last — if a finding's own detail quotes a
 * marker literal (this gate audits itself, so a finding ABOUT the fingerprint
 * scheme naturally does), the first match in the body is that quoted text, not
 * the trailing marker that is actually load-bearing.
 */
export function extractFingerprint(body) {
  if (typeof body !== 'string') return null;
  const matches = [...body.matchAll(/<!--\s*audit-fp:([^>]*?)\s*-->/g)];
  if (!matches.length) return null;
  return normalizeFingerprint(matches[matches.length - 1][1].trim());
}

/**
 * Issues filed while the key was `dimension|file|line` (before #1738 dropped
 * the line) still carry that three-part marker — 195 of the 200 open
 * `audit-followup` issues when the key changed. Read back verbatim, none of
 * them would match the two-part key `followupFingerprint` now computes, and
 * every one would be filed again. Keeping the first two segments makes a
 * legacy marker mean what the current key means.
 */
export function normalizeFingerprint(fp) {
  const parts = fp.split('|');
  return parts.length > 2 ? parts.slice(0, 2).join('|') : fp;
}

/** Hidden marker identifying a location COMMENT (distinct from an issue body). */
export const LOCATION_COMMENT_PREFIX = 'audit-cmt:';

/**
 * The marker a location comment carries so the next run recognises its own.
 *
 * Keyed on (location, pull request). Deliberately NOT the title — that is the
 * text the model rewords, which is what sends the finding down this path in the
 * first place. And deliberately NOT the commit: the gate runs on every push, so
 * a per-commit key posts a fresh comment per push, which is the unbounded
 * growth this exists to stop. Per-PR is the coarsest key that still says
 * something true — "this open issue was re-reported by this pull request".
 */
export function locationCommentMarker({ fingerprint, pr }) {
  if (!fingerprint) return null;
  return `<!-- ${LOCATION_COMMENT_PREFIX}${fingerprint}|pr-${pr ?? 'unknown'} -->`;
}

/**
 * The existing comment carrying `marker`, or null.
 *
 * Same rule as `resolveMarkerComment`: found is found, even on a partial read.
 * The caller decides what a null means, because here — unlike the PR comment —
 * a null it cannot vouch for must NOT be posted through.
 */
export function findMarkedComment(items, marker) {
  if (!marker || !Array.isArray(items)) return null;
  return items.find(c => c && typeof c.body === 'string' && c.body.includes(marker)) ?? null;
}

/**
 * Collapse `toComment` into one comment per target issue.
 *
 * Every entry landing on a given issue shares a fingerprint by construction —
 * the fingerprint is how the issue was resolved — so a group is exactly "the
 * findings at this location in this run". Grouping is what lets the upsert key
 * on the location alone without losing the second of two genuinely different
 * defects at one line: they travel in one comment rather than one each.
 *
 * @param resolveSameRun maps a fingerprint filed earlier in THIS run to its new
 *        issue number; entries it cannot resolve (the issue was capped out) come
 *        back as `unresolved` rather than being dropped on the floor silently.
 */
export function groupCommentsByIssue(toComment, resolveSameRun = () => undefined) {
  const groups = new Map();
  const unresolved = [];

  for (const entry of toComment) {
    const fingerprint = entry.sameRunFingerprint ?? followupFingerprint(entry.finding);
    const issueNumber = entry.issueNumber ?? resolveSameRun(fingerprint);
    // No number means its issue never got filed; no fingerprint means there is
    // no key to upsert on. Either way this run cannot comment it — and the PR
    // comment carries it in full regardless.
    if (!issueNumber || !fingerprint) {
      unresolved.push(entry);
      continue;
    }
    let group = groups.get(issueNumber);
    if (!group) {
      group = { issueNumber, fingerprint, findings: [] };
      groups.set(issueNumber, group);
    }
    group.findings.push(entry.finding);
  }

  return { groups: [...groups.values()], unresolved };
}

/**
 * GitHub rejects an issue comment body over 65,536 characters. A location
 * comment concatenates EVERY grouped finding's full detail with no bound, and
 * grouping by location puts more findings into one comment — so the limit is
 * reachable, and a rejected write used to be logged as a success (issue 2206).
 * Cap below the limit with room for the footer and marker.
 */
export const LOCATION_COMMENT_MAX_CHARS = 60_000;

/**
 * The body of a location comment: every finding at this location in this run,
 * then the PR footer and the upsert marker. The marker is ALWAYS last and
 * always kept — a truncated body that lost it would be re-posted, not edited,
 * on the next run. Over the cap, finding text is cut and the cut is SAID.
 */
export function buildLocationCommentBody({ findings, prUrl, headSha, marker }) {
  const head = [`**Also reported at this location** by the scoped-audit gate:`, ''];
  const blocks = findings.flatMap(f => [
    `**${f.severity}** — ${f.title || 'untitled'}`,
    '',
    f.detail || '(no detail)',
    '',
  ]);
  const tail = [
    `_PR: ${prUrl} — latest audit commit: ${headSha ? headSha.slice(0, 8) : 'unknown'}_`,
    marker,
  ];
  let middle = blocks.join('\n');
  const fixed = head.join('\n').length + tail.join('\n').length + 2;
  const budget = LOCATION_COMMENT_MAX_CHARS - fixed;
  if (middle.length > budget) {
    const note =
      "\n\n_…truncated: this location's findings exceed GitHub's comment size limit. " +
      'The PR comment carries every finding in full._\n';
    middle = middle.slice(0, Math.max(0, budget - note.length)) + note;
  }
  return [...head, middle, ...tail].join('\n');
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
  // fingerprint -> existing issue number. Absent (an older caller) simply means
  // no location matching, which degrades to the previous title-only behaviour
  // rather than erroring.
  openFingerprints = new Map(),
  cap,
  // Bounds the `toComment` path (#1752): each entry costs a paginated read of
  // the target issue's comments plus a write, and unlike `toFile` this path
  // has no natural volume limit — it is reached once per already-tracked
  // location this run re-reports, which can outnumber `cap` on a heavily
  // audited file. Overflow goes to `overCap`, same as an over-cap new issue:
  // nothing is lost, the PR comment still carries it in full. Defaults to
  // `cap` so an older caller that only passes `cap` still gets a bound.
  commentCap = cap,
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
      toComment: [],
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
  const toComment = [];
  const seenThisRun = new Set();
  const seenFpThisRun = new Set();

  for (const f of ordered) {
    const title = followupIssueTitle(f);
    const fp = followupFingerprint(f);

    // A single run can produce the same title twice (the same defect reported
    // against two files); filing it twice would defeat the dedup on the NEXT
    // run too, since both copies would then be open.
    if (openTitles.has(title) || seenThisRun.has(title)) {
      alreadyTracked.push(f);
      continue;
    }

    // Same LOCATION as an issue that is already open, but worded differently —
    // which is the case that produced 929 of these. Post it on the existing
    // issue instead of opening a second one. Not dropped: if the two really
    // are different defects at one line, a human sees both in one place.
    const existing = fp === null ? undefined : openFingerprints.get(fp);
    if (existing !== undefined) {
      if (toComment.length >= commentCap) {
        overCap.push(f);
        continue;
      }
      toComment.push({ finding: f, issueNumber: existing });
      continue;
    }

    // Two findings at the same location within ONE run: the first is filed and
    // the rest comment onto it after it exists, so they are held here and
    // resolved by the caller once the issue number is known.
    if (fp !== null && seenFpThisRun.has(fp)) {
      if (toComment.length >= commentCap) {
        overCap.push(f);
        continue;
      }
      toComment.push({ finding: f, issueNumber: null, sameRunFingerprint: fp });
      continue;
    }

    if (toFile.length >= cap) {
      overCap.push(f);
      continue;
    }
    seenThisRun.add(title);
    if (fp !== null) seenFpThisRun.add(fp);
    toFile.push(f);
  }

  return { toFile, alreadyTracked, overCap, untracked, toComment, dedupIncomplete: false };
}

function severityRank(severity) {
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return rank[severity] ?? 4;
}
