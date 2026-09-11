#!/usr/bin/env node
/**
 * Fail when a `.zap/rules.tsv` suppression has outlived its `review-by:` date.
 *
 * Runs in the NIGHTLY zap-baseline workflow, not in the PR-blocking unit suite.
 * That split is the whole point: an expiry assertion in `tests/unit` means that
 * on the review date every unrelated pull request — a hotfix included — fails
 * CI on a ZAP suppression, with no way to tell "this PR broke something" from
 * "a calendar date passed". Here it alerts through the same Telegram path as a
 * scan failure and blocks nobody.
 *
 * The complementary half — every IGNORE HAS a date — stays PR-blocking in
 * `tests/unit/zap-rules-have-review-dates.test.ts`, because that can only fail
 * in response to something the author actually did.
 *
 * `review-by:2026-12-31` means "suppressed THROUGH 2026-12-31", so the check
 * compares against the end of that day, not its start.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = join(ROOT, '.zap/rules.tsv');
const DAY_MS = 86_400_000;

const rows = readFileSync(RULES, 'utf8')
  .split('\n')
  .map((raw, i) => ({ raw: raw.trim(), line: i + 1 }))
  .filter(r => r.raw && !r.raw.startsWith('#'))
  .map(r => {
    const [id, action, ...rest] = r.raw.split('\t');
    const comment = rest.join('\t');
    const m = comment.match(/review-by:(\d{4}-\d{2}-\d{2})/);
    return { id, action, comment, reviewBy: m ? m[1] : null, line: r.line };
  });

// A parse that finds nothing is not a pass. Without this, a moved or renamed
// file would report "all suppressions current" having read zero of them.
if (rows.length === 0) {
  console.error(
    `::error::check-zap-review-dates: parsed 0 rules from ${RULES} — the file moved, or the format changed.`
  );
  process.exit(1);
}

// A duplicated rule id is a latent contradiction — two rows for 10055, one
// IGNORE and one WARN, and which wins is ZAP's parsing order, not a decision
// anyone made. This file grew two duplicates the first time it was rewritten
// by hand, so the check is here rather than in a reviewer's head.
const seen = new Map();
const dupes = [];
for (const r of rows) {
  if (seen.has(r.id)) dupes.push({ ...r, first: seen.get(r.id) });
  else seen.set(r.id, r.line);
}
for (const d of dupes) {
  console.error(
    `::error file=.zap/rules.tsv,line=${d.line}::rule ${d.id} is listed twice ` +
      `(also on line ${d.first}). Which row wins is ZAP's parsing order, not a decision.`
  );
}

const now = Date.now();
const expired = [];
const undated = [];

for (const r of rows) {
  if (r.action !== 'IGNORE') continue;
  if (!r.reviewBy) {
    undated.push(r);
    continue;
  }
  // "through this date": the suppression lapses at the END of the named day.
  const lapses = new Date(`${r.reviewBy}T00:00:00Z`).getTime() + DAY_MS;
  if (lapses <= now) expired.push(r);
}

const ignores = rows.filter(r => r.action === 'IGNORE').length;

for (const r of undated) {
  console.error(
    `::error file=.zap/rules.tsv,line=${r.line}::rule ${r.id} is IGNOREd with no review-by:<YYYY-MM-DD>.`
  );
}
for (const r of expired) {
  console.error(
    `::error file=.zap/rules.tsv,line=${r.line}::rule ${r.id} was suppressed through ` +
      `${r.reviewBy}, which has passed. Re-justify it with a new date or delete the line — ` +
      `do not bump the date without re-checking the reason: "${r.comment.split(';')[0]}".`
  );
}

if (expired.length || undated.length || dupes.length) {
  console.error(
    `check-zap-review-dates: ${expired.length} expired, ${undated.length} undated, ` +
      `${dupes.length} duplicated, of ${ignores} suppressions.`
  );
  process.exit(1);
}

console.log(`check-zap-review-dates: ${ignores} suppressions, all dated and current.`);
