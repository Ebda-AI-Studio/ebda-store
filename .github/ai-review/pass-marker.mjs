#!/usr/bin/env node
// Keeps the `ai-review-passed` label tied to the DIFF that was reviewed, not to the head commit.
// `gh pr update-branch` (a clean merge of main) pushes a new head but leaves the PR's own diff unchanged; stripping the label on every push
// wiped 18 approvals at once. The reviewed diff is fingerprinted with `git patch-id --stable` (ignores line numbers and context, so main moving
// under the PR does not change it) and stored in a marker comment written by github-actions[bot]:  <!-- ai-review-patch-id:<id> -->
//   record      after a pass (bot or manual label): upsert the marker with the PR's current patch-id
//   revalidate  on a push: keep the label when the PR's current patch-id equals the marker, strip it otherwise (new commit that changes
//               the diff, a merge whose conflict resolution changed it, no marker, or the diff cannot be read: unknown is not pass)
// Env: GH_REPO (owner/repo), PR (number), GITHUB_OUTPUT (revalidate writes kept=true|false). Needs `gh` and `git` on PATH.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LABEL = 'ai-review-passed';
const BOT = 'github-actions[bot]';
const MARK = /<!-- ai-review-patch-id:([0-9a-f]{40}) -->/;
const run = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });

/** the PR's own diff (against the merge-base) fingerprinted, or null when it cannot be read */
export function currentPatchId(pr) {
  try {
    const diff = run('gh', ['pr', 'diff', String(pr)]);
    if (!diff.trim()) return null;
    return run('git', ['patch-id', '--stable'], diff).trim().split(/\s+/)[0] || null;
  } catch { return null; }
}

function comments(repo, pr) {
  const out = run('gh', ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--jq', '.[] | {id, login: .user.login, body}']);
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/** the newest marker the BOT wrote; a comment from anyone else is ignored (a PR author must not be able to forge one) */
export function storedPatchId(repo, pr) {
  const mine = comments(repo, pr).filter((c) => c.login === BOT && MARK.test(c.body));
  return { id: mine.length ? MARK.exec(mine[mine.length - 1].body)[1] : null, commentId: mine.length ? mine[mine.length - 1].id : null };
}

export function record(repo, pr) {
  const id = currentPatchId(pr);
  if (!id) { console.log('pass-marker: the PR diff cannot be fingerprinted; no marker written (the next push will strip the label)'); return null; }
  const body = `<!-- ai-review-patch-id:${id} -->\nai-review-passed covers the diff with patch-id \`${id}\`. A push that does not change this diff (for example a merge of main) keeps the label; any other change removes it.`;
  const { commentId } = storedPatchId(repo, pr);
  if (commentId) run('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${commentId}`, '-f', `body=${body}`]);
  else run('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`]);
  console.log(`pass-marker: recorded ${id}`);
  return id;
}

export function revalidate(repo, pr) {
  const labels = run('gh', ['pr', 'view', String(pr), '--json', 'labels', '--jq', '.labels[].name']).split('\n');
  if (!labels.includes(LABEL)) { console.log('pass-marker: no ai-review-passed label; nothing to keep'); return false; }
  const stored = storedPatchId(repo, pr).id;
  const now = currentPatchId(pr);
  if (stored && now && stored === now) { console.log(`pass-marker: diff unchanged (${now}); label kept`); return true; }
  run('gh', ['pr', 'edit', String(pr), '--remove-label', LABEL]);
  console.log(`pass-marker: label stripped (${!stored ? 'no marker' : !now ? 'diff unreadable' : `diff changed ${stored} -> ${now}`})`);
  return false;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { GH_REPO, PR, GITHUB_OUTPUT } = process.env;
  if (!GH_REPO || !PR) { console.error('pass-marker: GH_REPO and PR are required'); process.exit(2); }
  const cmd = process.argv[2];
  if (cmd === 'record') record(GH_REPO, PR);
  else if (cmd === 'revalidate') {
    const kept = revalidate(GH_REPO, PR);
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `kept=${kept}\n`);
  } else { console.error('usage: pass-marker.mjs record|revalidate'); process.exit(2); }
}
