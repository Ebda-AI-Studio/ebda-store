#!/usr/bin/env node
// Binds the `ai-review-passed` label to the EXACT reviewed content, so a clean merge of main (`gh pr update-branch`) keeps it and anything else strips it.
//
// What a pass is bound to (a marker comment written by github-actions[bot]; a comment from anyone else is ignored):
//   <!-- ai-review-pass head=<40-hex head sha> diff=<64-hex sha256> -->
//   head  the PR head SHA of the event that was reviewed (never "whatever the PR is now")
//   diff  sha256 of the PR-only diff, byte for byte:  git diff --no-renames -U3 origin/<base>...<head>
//         (not `git patch-id`: that ignores whitespace and line numbers, so a different diff can collide with the reviewed one)
//
//   diff        print that diff for HEAD_SHA (the review job feeds exactly these bytes to the reviewer); refuses when the PR head moved
//   record      write the marker. Refuses (exit 1, nothing written) when: the live PR head is not HEAD_SHA (it moved between review and
//               record), DIFF_SHA256 (the hash of the diff the reviewer actually read, when given) differs from the recomputed one, or the
//               event is a label event for any label but ai-review-passed (an unrelated label must never record a pass)
//   revalidate  on a push: keep the label only when the new head DESCENDS from the stored head AND the PR-only diff hashes the same; then
//               re-bind the marker to the new head. Anything else (no marker, forged marker, head moved, not a descendant, content or even
//               whitespace changed, diff unreadable) strips the label: unknown is not pass.
// Env: GH_REPO, PR, HEAD_SHA, BASE_REF (default main); optional DIFF_SHA256, LABEL_NAME, GITHUB_OUTPUT (revalidate: kept=true|false).
// Needs a checkout whose `origin` is the base repo, with full history, plus `gh` on PATH.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LABEL = 'ai-review-passed';
const BOT = 'github-actions[bot]';
const MARK = /<!-- ai-review-pass head=([0-9a-f]{40}) diff=([0-9a-f]{64}) -->/;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const git = (...a) => run('git', a);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** fetch the PR head ref and require it to be exactly `headSha`; throws when the PR moved */
export function bindHead(pr, headSha) {
  if (!/^[0-9a-f]{40}$/.test(headSha ?? '')) throw new Error('HEAD_SHA must be the 40-hex head sha of the event');
  git('fetch', '--no-tags', 'origin', `+refs/pull/${pr}/head:refs/pr/head`);
  const live = git('rev-parse', 'refs/pr/head').trim();
  if (live !== headSha) throw new Error(`the PR head moved: event ${headSha.slice(0, 9)}, now ${live.slice(0, 9)}`);
}

/** the PR-only diff of headSha, byte for byte (explicit flags so no git config can change the bytes) */
export function prDiff(baseRef, headSha) {
  return git('diff', '--no-renames', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-U3', `origin/${baseRef}...${headSha}`);
}

function comments(repo, pr) {
  const out = run('gh', ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--jq', '.[] | {id, login: .user.login, body}']);
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/** the newest marker the BOT wrote */
export function storedMarker(repo, pr) {
  const mine = comments(repo, pr).filter((c) => c.login === BOT && MARK.test(c.body));
  if (!mine.length) return { head: null, diff: null, commentId: null };
  const last = mine[mine.length - 1];
  const m = MARK.exec(last.body);
  return { head: m[1], diff: m[2], commentId: last.id };
}

function writeMarker(repo, pr, head, diff) {
  const body = `<!-- ai-review-pass head=${head} diff=${diff} -->\nai-review-passed covers head \`${head.slice(0, 9)}\` and the PR-only diff with sha256 \`${diff.slice(0, 12)}\`. A push whose head descends from it and leaves that diff byte-identical (a clean merge of main) keeps the label; any other change removes it.`;
  const { commentId } = storedMarker(repo, pr);
  if (commentId) run('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${commentId}`, '-f', `body=${body}`]);
  else run('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`]);
}

export function record({ repo, pr, headSha, baseRef = 'main', reviewedDiffSha256, labelName }) {
  if (labelName && labelName !== LABEL) return { recorded: false, reason: `unrelated label "${labelName}": no pass is recorded` };
  bindHead(pr, headSha);
  const diff = sha256(prDiff(baseRef, headSha));
  if (reviewedDiffSha256 && reviewedDiffSha256 !== diff) throw new Error(`the diff at ${headSha.slice(0, 9)} (${diff.slice(0, 12)}) is not the diff the reviewer read (${reviewedDiffSha256.slice(0, 12)})`);
  writeMarker(repo, pr, headSha, diff);
  return { recorded: true, head: headSha, diff };
}

export function revalidate({ repo, pr, headSha, baseRef = 'main' }) {
  const labels = run('gh', ['pr', 'view', String(pr), '--json', 'labels', '--jq', '.labels[].name']).split('\n');
  if (!labels.includes(LABEL)) return { kept: false, reason: 'no ai-review-passed label; nothing to keep' };
  const strip = (reason) => { run('gh', ['pr', 'edit', String(pr), '--remove-label', LABEL]); return { kept: false, reason: `label stripped: ${reason}` }; };
  const stored = storedMarker(repo, pr);
  if (!stored.head) return strip('no marker from the bot');
  try { bindHead(pr, headSha); } catch (e) { return strip(e.message); }
  try { git('cat-file', '-e', `${stored.head}^{commit}`); git('merge-base', '--is-ancestor', stored.head, headSha); } catch { return strip(`head ${headSha.slice(0, 9)} does not descend from the reviewed head ${stored.head.slice(0, 9)}`); }
  let now;
  try { now = sha256(prDiff(baseRef, headSha)); } catch { return strip('the diff cannot be computed'); }
  if (now !== stored.diff) return strip(`the PR diff changed (${stored.diff.slice(0, 12)} -> ${now.slice(0, 12)})`);
  writeMarker(repo, pr, headSha, now);
  return { kept: true, reason: `descends from ${stored.head.slice(0, 9)}, diff byte-identical; label kept and marker moved to ${headSha.slice(0, 9)}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { GH_REPO: repo, PR: pr, HEAD_SHA: headSha, BASE_REF: baseRef = 'main', DIFF_SHA256: reviewedDiffSha256, LABEL_NAME: labelName, GITHUB_OUTPUT } = process.env;
  const cmd = process.argv[2];
  if (!pr || !['diff', 'record', 'revalidate'].includes(cmd ?? '') || (cmd !== 'diff' && !repo)) {
    console.error('usage: GH_REPO=o/r PR=n HEAD_SHA=<sha> [BASE_REF=main] pass-marker.mjs diff|record|revalidate'); process.exit(2);
  }
  try {
    if (cmd === 'diff') { bindHead(pr, headSha); process.stdout.write(prDiff(baseRef, headSha)); }
    else if (cmd === 'record') {
      const r = record({ repo, pr, headSha, baseRef, reviewedDiffSha256, labelName });
      console.log(r.recorded ? `pass-marker: recorded head ${r.head.slice(0, 9)} diff ${r.diff.slice(0, 12)}` : `pass-marker: ${r.reason}`);
    } else {
      const r = revalidate({ repo, pr, headSha, baseRef });
      console.log(`pass-marker: ${r.reason}`);
      if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `kept=${r.kept}\n`);
    }
  } catch (e) { console.error(`pass-marker: refused: ${e.message}`); process.exit(1); }
}
