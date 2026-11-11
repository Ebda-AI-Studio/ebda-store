// Consumes `claude -p --output-format json` output from the scoped-audit run.
// Parses findings, posts/upserts a single marker PR comment, appends to the
// GitHub step summary, gates on P0/P1, and files P2/P3 as tracked issues.
//
// Gate logic:
//   P0 or P1 confirmed → exit 1 (BLOCK merge)
//   P2 / P3 only       → file follow-up issues (non-blocking), exit 0
//   any infra/parse/network error → exit 0 (FAIL-OPEN — never falsely block)
//
// 2026-09-02 (adversarial audit, P2, tracked #1115): fail-open must not mean
// SILENT. Before this fix, "model ran, found nothing" and "model never ran"
// (bad --model alias, CLI crash, empty/unparseable output) were the same
// green check with the same "PASSED" comment — the CLI step above this one
// carries `continue-on-error: true`, so a broken model silently disabled the
// one gate that blocks P0/P1 merges, indefinitely, with no signal anywhere.
// The workflow step now writes AUDIT_RAN=true/false (+ AUDIT_RAN_REASON) to
// $GITHUB_OUTPUT; this script checks it FIRST and, when false, posts a
// distinct "did not run" PR comment + step-summary block + Telegram alert
// before doing anything else, then exits 0 (fail-open is preserved
// deliberately — see header above — but it is no longer quiet about it).
//
// Modeled on .github/ai-review/review.mjs — match its style exactly.

import { readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
  fetchOpenFollowupTitles,
  followupIssueTitle,
  selectFollowupsToFile,
  fingerprintMarker,
  followupFingerprint,
  locationCommentMarker,
  findMarkedComment,
  groupCommentsByIssue,
  buildLocationCommentBody,
} from './followup-filing.mjs';
import { fetchAllPages } from './gh-paginate.mjs';
import { nonRunExitCode, auditExitCode, auditVerdict, NON_RUN_REASONS } from './gate-policy.mjs';
import { resolveMarkerComment } from './marker-comment.mjs';
import { recoverTruncatedFindings } from './partial-json.mjs';

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  GITHUB_EVENT_NAME,
  PR_NUMBER,
  HEAD_SHA,
  // RUNNER_TEMP, never a fixed /tmp path: runners share the Mac host (Ruling CI-MAC-RUNNER-1).
  CLAUDE_OUTPUT = joinPath(process.env.RUNNER_TEMP || tmpdir(), 'scoped-audit-out.json'),
  GITHUB_OUTPUT,
  GITHUB_STEP_SUMMARY,
  AUDIT_RAN,
  AUDIT_RAN_REASON,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALERT_CHAT_ID,
} = process.env;

// --- pre-flight guards ---
//
// These three ran before anything could audit and then exited 0, so the check
// went green having reviewed nothing — and unlike the later non-run paths they
// raised no alert at all, so there was no comment, no summary and no Telegram
// either. A PR_NUMBER that fails to resolve is the realistic one: it produces a
// green `scoped-audit` tick on a pull request nothing looked at, with no trace.
//
// They cannot use alertAuditDidNotRun: `owner`, `repo`, `PR_URL` and `MARKER`
// are all declared BELOW this point, so calling it here throws a temporal dead
// zone ReferenceError before it can report anything — a louder failure than the
// silence, but still not the report. And by construction these guards fire
// exactly when the identity needed to post a comment is missing. So they report
// through the two channels that need nothing: the workflow log and the step
// summary.
function reportPreflightFailure(reason) {
  console.error(
    `::error::scoped-audit did NOT run (reason: ${reason}) — the gate reviewed nothing. This is not "no findings."`
  );
  if (GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        GITHUB_STEP_SUMMARY,
        `### ⚠️ Scoped Audit — DID NOT RUN\n\nReason: \`${reason}\`. The gate exited before auditing anything. This is a different state from "reviewed, no findings."\n`
      );
    } catch (e) {
      console.error('Step summary write failed (non-fatal):', e.message);
    }
  }
}

if (!GITHUB_TOKEN) {
  reportPreflightFailure(NON_RUN_REASONS.NO_GITHUB_TOKEN);
  process.exit(nonRunExitCode());
}
const repoParts = (GITHUB_REPOSITORY || '').split('/');
if (repoParts.length !== 2) {
  reportPreflightFailure(NON_RUN_REASONS.NO_REPOSITORY);
  process.exit(nonRunExitCode());
}
if (!PR_NUMBER) {
  // scoped-audit.yml declares workflow_dispatch as a supported trigger, and a
  // manual dispatch has no `github.event.pull_request` by construction — there
  // is no PR — so PR_NUMBER is empty there on purpose, not by mistake. Before
  // this guard existed that path exited 0 silently; after it, every dispatch
  // hit reportPreflightFailure + nonRunExitCode() and reported red forever,
  // which is how a real red tick on a supported path stops being read (#1521).
  // This is an expected no-op, not a masked failure, so it says so plainly and
  // exits 0 — the pull_request-triggered path below still fails loud when
  // PR_NUMBER really is missing on the trigger that requires it.
  if (GITHUB_EVENT_NAME && GITHUB_EVENT_NAME !== 'pull_request') {
    console.log(
      `scoped-audit: '${GITHUB_EVENT_NAME}' trigger has no pull request to audit — nothing to ` +
        `do. This is expected for a non-pull_request trigger, not a failure.`
    );
    process.exit(0);
  }
  reportPreflightFailure(NON_RUN_REASONS.NO_PR_NUMBER);
  process.exit(nonRunExitCode());
}

const [owner, repo] = repoParts;

// ---------------------------------------------------------------------------
// GitHub REST helper + shared constants (moved ahead of the parsing logic so
// the AUDIT_RAN=false short-circuit below can use them too).
// ---------------------------------------------------------------------------
async function gh(method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.error(`gh ${method} ${path} -> ${r.status}`, txt.slice(0, 300));
  }
  return r;
}

const SEV_ICON = { P0: '🔴', P1: '🔴', P2: '🟡', P3: '🔵' };

/**
 * Most NEW issues a single audit run may file. The PR comment carries every
 * finding in full regardless, so this bounds the tracker, not the review.
 * Governs `toFile` only — see MAX_COMMENTS_PER_RUN for the separate bound on
 * the `toComment` (already-tracked-location) write path.
 */
const MAX_ISSUES_PER_RUN = 10;

/**
 * Most location-comment upserts a single run may perform (#1752). Each entry
 * costs a paginated read of the target issue's comments plus a write, and this
 * path is reached once per already-tracked location the run re-reports, which
 * a heavily-audited file can exceed independently of MAX_ISSUES_PER_RUN.
 * Overflow is reported the same way an over-cap new issue is: nothing lost,
 * still in the PR comment.
 */
const MAX_COMMENTS_PER_RUN = 10;

const PR_URL = `https://github.com/${owner}/${repo}/pull/${PR_NUMBER}`;
const MARKER = '<!-- scoped-audit-bot -->';

async function upsertMarkerComment(body) {
  try {
    // The whole comment list: a marker past the first page would otherwise read
    // as absent and this would post a duplicate audit comment on every run.
    const { items, complete } = await fetchAllPages({
      gh,
      path: `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`,
    });
    const { prior, uncertain } = resolveMarkerComment({ items, complete, marker: MARKER });
    let resp;
    if (prior) {
      resp = await gh('PATCH', `/repos/${owner}/${repo}/issues/comments/${prior.id}`, { body });
    } else {
      // A partial read cannot vouch that no marker exists, but this comment is
      // the ONLY place P3 and over-cap findings are reported — a duplicate is
      // recoverable, a silently unreported finding is not. Post, and say so.
      if (uncertain) {
        console.log(
          `::warning::scoped-audit could not read the full PR comment list; posting a fresh ` +
            `audit comment. If an earlier audit comment already exists, this run duplicates it.`
        );
      }
      resp = await gh('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, { body });
    }
    // gh() only console.error()s a non-ok response, it never throws — so an
    // HTTP rejection (comment body over GitHub's 65536-char limit, a token
    // missing `pull-requests: write`, a secondary rate limit) fell through
    // the catch below untouched and this function returned having silently
    // failed to record the ONLY place P3 and over-cap findings are reported.
    // Check the response explicitly (#1453).
    if (!resp.ok) {
      console.error(
        `::error::scoped-audit's PR comment write failed (HTTP ${resp.status}). This commit's ` +
          `P3 and over-cap P2 findings exist ONLY in this job's log and step summary — the PR ` +
          `comment does not carry them.`
      );
    }
  } catch (e) {
    // NOT non-fatal in any useful sense: the gate below may block this PR, and
    // without this comment the reviewer is left reading the PREVIOUS commit's
    // findings under a fresh red X — which is how a resolved P0 gets chased
    // while the live P1 that actually blocked the merge goes unread.
    console.log(
      `::error::scoped-audit could not post its findings to the PR (${e.message}). ` +
        `Any audit comment currently shown belongs to an EARLIER commit. The findings ` +
        `for this commit are in this job's log and step summary.`
    );
  }
}

// ---------------------------------------------------------------------------
// 0. AUDIT_RAN sentinel — "model ran, found nothing" vs "model never ran"
// ---------------------------------------------------------------------------
async function alertAuditDidNotRun(reason) {
  const reasonText = reason || 'unknown';
  console.error(
    `::error::scoped-audit did NOT run for this PR (reason: ${reasonText}) — the blast-radius gate reviewed nothing. This is not "no findings."`
  );

  if (GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        GITHUB_STEP_SUMMARY,
        `### ⚠️ Scoped Audit — DID NOT RUN\n\nReason: \`${reasonText}\`. This PR has NOT been reviewed by the blast-radius audit gate — this is a different state from "reviewed, no findings." See the CLI step logs above.\n`
      );
    } catch (e) {
      console.error('Step summary write failed (non-fatal):', e.message);
    }
  }

  try {
    await upsertMarkerComment(
      `${MARKER}\n### ⚠️ Scoped Audit — DID NOT RUN\n\nReason: \`${reasonText}\`. The blast-radius audit gate did not produce a result for this PR — that is NOT the same as "no P0/P1 findings." Re-run \`workflow_dispatch\` on \`Scoped Audit Gate\` once the underlying issue is fixed, or have a human review this PR before merging.\n`
    );
  } catch (e) {
    console.error('audit-did-not-run PR comment failed (non-fatal):', e.message);
  }

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_ALERT_CHAT_ID) {
    try {
      const msg =
        `⚠️ *scoped-audit did not run* — PR #${PR_NUMBER} (${owner}/${repo})\n` +
        `reason: \`${reasonText}\`\n${PR_URL}`;
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          chat_id: TELEGRAM_ALERT_CHAT_ID,
          parse_mode: 'Markdown',
          disable_web_page_preview: 'true',
          text: msg,
        }),
      });
    } catch (e) {
      console.error('Telegram alert failed (non-fatal):', e.message);
    }
  } else {
    console.error(
      'TELEGRAM_BOT_TOKEN/TELEGRAM_ALERT_CHAT_ID not set — alert is PR comment + logs only.'
    );
  }
}

if (AUDIT_RAN === 'false') {
  await alertAuditDidNotRun(AUDIT_RAN_REASON);
  // Still fail-open in the sense that matters: this gate is NOT one of the
  // eleven required checks, so a non-zero exit informs without blocking the
  // merge. What it stops doing is claiming to have PASSED — exiting zero
  // rendered the check green, and green is what a merge decision reads. See
  // gate-policy.mjs. Nothing below this point has anything to parse.
  process.exit(nonRunExitCode());
}

// ---------------------------------------------------------------------------
// 1. Read and parse Claude's JSON envelope (.result)
// ---------------------------------------------------------------------------
let modelText;
try {
  const envelope = JSON.parse(readFileSync(CLAUDE_OUTPUT, 'utf8'));
  modelText = typeof envelope === 'string' ? envelope : envelope.result;
} catch (e) {
  console.error('Could not read Claude output:', e.message);
  await alertAuditDidNotRun(`AUDIT_RAN was not 'false' but output was unreadable: ${e.message}`);
  process.exit(nonRunExitCode());
}
if (!modelText) {
  console.error('Empty model result — skipping gate (fail-open).');
  await alertAuditDidNotRun("AUDIT_RAN was not 'false' but model result was empty");
  process.exit(nonRunExitCode());
}

// Tolerate code fences / surrounding prose (same extractJson as review.mjs)
function extractJson(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return candidate.slice(start, end + 1);
}

let result;
// True when the model's response was cut off and only the findings before the
// cutoff were recovered. Threaded to the verdict and the exit code: a partial
// audit with nothing blocking is PARTIAL + a non-run exit, never PASSED + 0.
let partial = false;
try {
  result = JSON.parse(extractJson(modelText));
} catch (e) {
  // A large diff (scripts/scoped-audit.sh caps it at ~150KB, roughly the
  // ~12k-line diffs where this was first observed) can make the model's OWN
  // response long enough to be cut off mid-generation — an incomplete
  // `findings` array that fails JSON.parse outright. Reporting that as "DID
  // NOT RUN" drops every finding the model DID manage to write down, on
  // exactly the largest, riskiest PRs. Recover what parses as complete and
  // degrade to a partial, explicitly-labelled audit instead of silence.
  const recovered = recoverTruncatedFindings(extractJson(modelText));
  if (recovered) {
    console.error(
      `::warning::scoped-audit's model output did not parse as complete JSON — likely truncated ` +
        `on a large diff. Recovered ${recovered.findings.length} complete finding(s) before the ` +
        `cutoff; this audit is PARTIAL.`
    );
    partial = true;
    result = {
      summary:
        `⚠️ This audit is PARTIAL — the diff was large and the model's response was truncated ` +
        `before it finished. ${recovered.findings.length} finding(s) below were recovered from ` +
        `before the cutoff; anything past that point was not reviewed. Re-run once the diff is ` +
        `smaller, or review the tail of this PR manually.`,
      findings: recovered.findings,
    };
  } else {
    console.error('Model did not return valid JSON:\n', modelText);
    await alertAuditDidNotRun(
      `AUDIT_RAN was not 'false' but model output did not parse as JSON: ${e.message}`
    );
    process.exit(nonRunExitCode());
  }
}

const findings = Array.isArray(result.findings) ? result.findings : [];
const p0 = findings.filter(f => f.severity === 'P0');
const p1 = findings.filter(f => f.severity === 'P1');
const p2 = findings.filter(f => f.severity === 'P2');
const p3 = findings.filter(f => f.severity === 'P3');
const blocking = [...p0, ...p1];

console.log(`scoped-audit: P0=${p0.length} P1=${p1.length} P2=${p2.length} P3=${p3.length}`);

// ---------------------------------------------------------------------------
// 3. Build PR comment body
// ---------------------------------------------------------------------------
function findingRow(f) {
  const icon = SEV_ICON[f.severity] || '';
  const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '_(file-level)_';
  return (
    `<details><summary>${icon} <strong>${f.severity}</strong> · <code>${f.dimension || 'audit'}</code> · ${f.title || '(no title)'}</summary>\n\n` +
    `**Location:** ${loc}\n\n` +
    `**Detail:** ${f.detail || '(no detail)'}\n\n` +
    `**Fix:** ${f.fix || '(no fix provided)'}\n\n` +
    `**Blast radius:** ${f.blastRadius || 'none identified'}\n\n` +
    `</details>`
  );
}

const headerLines = [
  MARKER,
  `### Scoped Audit — ${auditVerdict({ blockingFindings: blocking.length, partial })}`,
  '',
  result.summary || '',
  '',
  `| Severity | Count |`,
  `|----------|-------|`,
  `| 🔴 P0 | ${p0.length} |`,
  `| 🔴 P1 | ${p1.length} |`,
  `| 🟡 P2 | ${p2.length} |`,
  `| 🔵 P3 | ${p3.length} |`,
  '',
];

const blockingSection =
  blocking.length > 0
    ? [
        '#### Blocking findings (P0/P1) — must be resolved before merge',
        '',
        ...blocking.map(findingRow),
        '',
      ]
    : partial
      ? [
          '_No P0/P1 findings in the part of the diff the model reached — the rest was NOT reviewed. This is not a pass; review the tail of this PR manually or re-run on a smaller diff._',
          '',
        ]
      : ['_No P0/P1 findings — merge is unblocked by this gate._', ''];

const followupSection =
  p2.length + p3.length > 0
    ? [
        `#### Follow-up findings — non-blocking (P2 tracked as issues; P3 recorded here only)`,
        '',
        ...[...p2, ...p3].map(findingRow),
        '',
      ]
    : [];

const commentBody = [
  ...headerLines,
  ...blockingSection,
  ...followupSection,
  `_Audit commit: ${HEAD_SHA ? HEAD_SHA.slice(0, 8) : 'unknown'}_`,
].join('\n');

// ---------------------------------------------------------------------------
// 4. UPSERT the single marker PR comment
// ---------------------------------------------------------------------------
try {
  await upsertMarkerComment(commentBody);
} catch (e) {
  console.error('upsertMarkerComment threw (non-fatal):', e.message);
}

// ---------------------------------------------------------------------------
// 5. Append to GITHUB_STEP_SUMMARY
// ---------------------------------------------------------------------------
if (GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(GITHUB_STEP_SUMMARY, commentBody + '\n');
  } catch (e) {
    console.error('Step summary write failed (non-fatal):', e.message);
  }
}

// ---------------------------------------------------------------------------
// 6. File P2/P3 findings as tracked GitHub Issues (deduplicated by title)
// ---------------------------------------------------------------------------
async function fileFollowupIssues(followups) {
  // Dedup against EVERY open followup, not the first page of them.
  let openTitles = new Set();
  let openFingerprints = new Map();
  let dedupComplete = false;
  try {
    ({
      titles: openTitles,
      fingerprints: openFingerprints,
      complete: dedupComplete,
    } = await fetchOpenFollowupTitles({ gh, owner, repo }));
  } catch (e) {
    console.error('Could not fetch open issues for dedup:', e.message);
  }

  const { toFile, alreadyTracked, overCap, untracked, toComment, dedupIncomplete } =
    selectFollowupsToFile({
      followups,
      openTitles,
      openFingerprints,
      cap: MAX_ISSUES_PER_RUN,
      commentCap: MAX_COMMENTS_PER_RUN,
      dedupComplete,
    });

  if (dedupIncomplete) {
    console.log(
      `::warning::scoped-audit could not read the open followups, so it filed none of ` +
        `this run's ${followups.length} — filing against an unknown baseline is what ` +
        `duplicates them. All of them are in the PR comment.`
    );
  } else {
    console.log(
      `scoped-audit: ${followups.length} followups — filing ${toFile.length}, ` +
        `${alreadyTracked.length} already tracked, ${toComment.length} commented onto an ` +
        `existing issue at the same location, ${untracked.length} recorded on the PR ` +
        `only, ${overCap.length} over the per-run cap (new issues capped at ` +
        `${MAX_ISSUES_PER_RUN}, location comments capped at ${MAX_COMMENTS_PER_RUN}) ` +
        `(all of them are in the PR comment)`
    );
  }

  // fingerprint -> issue number for issues created in THIS run, so a second
  // finding at the same location comments onto the one just filed.
  const filedThisRun = new Map();

  for (const f of toFile) {
    const issueTitle = followupIssueTitle(f);
    const issueBody = [
      `**PR:** ${PR_URL}`,
      `**Commit:** ${HEAD_SHA || 'unknown'}`,
      '',
      `**Dimension:** ${f.dimension || 'audit'}`,
      `**Severity:** ${f.severity}`,
      `**Location:** \`${f.file || '(unknown)'}${f.line ? `:${f.line}` : ''}\``,
      '',
      '**Detail:**',
      f.detail || '(no detail)',
      '',
      '**Fix:**',
      f.fix || '(no fix provided)',
      '',
      '**Blast radius:**',
      f.blastRadius || 'none identified',
      '',
      '---',
      `_Filed automatically by the scoped-audit CI gate._`,
      // Hidden location fingerprint. This is what the NEXT run dedupes on, so
      // a reworded title resolves here instead of opening a second issue.
      // Must stay in the body — GitHub does not render it, and there is
      // nowhere else the list endpoint would return it from.
      fingerprintMarker(f),
    ].join('\n');

    try {
      // gh() resolves to the Response, never to the parsed body — reading
      // `.number` off it yielded undefined on every filing, so filedThisRun was
      // always empty and the same-run branch below could never resolve.
      const resp = await gh('POST', `/repos/${owner}/${repo}/issues`, {
        title: issueTitle,
        body: issueBody,
        labels: ['audit-followup', f.severity.toLowerCase()],
      });
      const created = resp.ok ? await resp.json().catch(() => null) : null;
      if (created?.number) filedThisRun.set(followupFingerprint(f), created.number);
      if (resp.ok) console.log(`scoped-audit: filed issue: ${issueTitle}`);
      else console.error(`scoped-audit: issue filing rejected for "${issueTitle}"`);
    } catch (e) {
      console.error(`Issue filing failed for "${issueTitle}" (non-fatal):`, e.message);
    }
  }

  // A finding at a location already tracked goes on the EXISTING issue rather
  // than into a new one. Never dropped: if it really is a second, different
  // defect at that line, a human reads both in one place — which is strictly
  // better than the duplicate issue this replaces, and strictly better than
  // the silent suppression a pure location key would have caused.
  //
  // UPSERT, not post. This path is reached exactly when a defect persists and
  // the model rewords it, and the gate runs on every push — so posting
  // unconditionally would leave one new comment per push per issue, forever:
  // #116's 929 duplicate issues turned into the same unbounded growth one level
  // down. Each comment carries a hidden (location, PR) marker and this edits it
  // in place, the same shape as upsertMarkerComment above. Findings sharing a
  // location travel in ONE comment, so keying on the location loses none of them.
  const { groups, unresolved } = groupCommentsByIssue(toComment, fp => filedThisRun.get(fp));
  if (unresolved.length) {
    console.log(
      `scoped-audit: ${unresolved.length} same-location finding(s) had no issue to comment ` +
        `on (filed over the cap); the PR comment still carries them in full`
    );
  }

  for (const group of groups) {
    const marker = locationCommentMarker({ fingerprint: group.fingerprint, pr: PR_NUMBER });
    // Size-capped (issue 2206): an over-limit body is rejected by GitHub.
    const body = buildLocationCommentBody({
      findings: group.findings,
      prUrl: PR_URL,
      headSha: HEAD_SHA,
      marker,
    });

    try {
      const { items, complete } = await fetchAllPages({
        gh,
        path: `/repos/${owner}/${repo}/issues/${group.issueNumber}/comments`,
      });
      // A null marker on a partial read is not evidence of absence, and acting
      // on it posts the duplicate. Unlike the PR comment — which is the only
      // place some findings are reported, so it posts through uncertainty —
      // this comment is a convenience on top of a finding the PR comment
      // already carries in full. So it fails closed, same as the issue dedup.
      if (!complete) {
        console.log(
          `::warning::scoped-audit could not read #${group.issueNumber}'s comments; skipping ` +
            `its location comment rather than risking a duplicate. It is in the PR comment.`
        );
        continue;
      }

      // Both writes CHECK the response (issue 2206). gh() only logs a non-ok
      // status and never throws, so these used to print success over a
      // rejected write — the same #1453 class the issue-filing write above
      // already handles — and the finding was tracked nowhere.
      const prior = findMarkedComment(items, marker);
      const resp = prior
        ? await gh('PATCH', `/repos/${owner}/${repo}/issues/comments/${prior.id}`, { body })
        : await gh('POST', `/repos/${owner}/${repo}/issues/${group.issueNumber}/comments`, {
            body,
          });
      if (!resp.ok) {
        console.log(
          `::warning::scoped-audit could not ${prior ? 'update' : 'post'} its location comment on ` +
            `#${group.issueNumber} (HTTP ${resp.status}). The finding is still in the PR comment.`
        );
      } else if (prior) {
        console.log(`scoped-audit: updated its existing location comment on #${group.issueNumber}`);
      } else {
        console.log(
          `scoped-audit: commented on #${group.issueNumber} instead of filing a duplicate`
        );
      }
    } catch (e) {
      console.error(`Comment on #${group.issueNumber} failed (non-fatal):`, e.message);
    }
  }
}

try {
  await fileFollowupIssues([...p2, ...p3]);
} catch (e) {
  console.error('fileFollowupIssues threw (non-fatal):', e.message);
}

// ---------------------------------------------------------------------------
// 7. Gate decision
// ---------------------------------------------------------------------------
if (blocking.length > 0) {
  // Write output for downstream steps (informational — they won't run if we exit 1)
  if (GITHUB_OUTPUT) {
    try {
      appendFileSync(GITHUB_OUTPUT, 'should_block=true\n');
    } catch (_) {
      // non-fatal
    }
  }
  console.error(
    `scoped-audit: BLOCKED — ${blocking.length} P0/P1 finding(s) confirmed. Resolve before merging.`
  );
  process.exit(auditExitCode({ blockingFindings: blocking.length, partial }));
}

if (partial) {
  console.error(
    'scoped-audit: PARTIAL — no P0/P1 in the part of the diff the model reached; the rest was ' +
      'not reviewed. Exiting red (informational, not a required check), not PASSED.'
  );
} else {
  console.log('scoped-audit: PASSED — no P0/P1 findings.');
}
process.exit(auditExitCode({ blockingFindings: 0, partial }));
