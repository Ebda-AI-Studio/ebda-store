#!/usr/bin/env node
// Is the `ai-review-passed` label still valid for the current head? Same rule as the drain: the label counts ONLY when its latest `labeled`
// timeline event is newer than the head commit's committer date. A push after the label makes it stale even before any strip run removes it,
// so two workflow runs that race (a check reading the label before an earlier strip lands) cannot pass a stale approval.
//   states: absent (not on the PR) | stale (on the PR, but no `labeled` event newer than the head commit) | valid
// Env: GH_REPO, PR, HEAD_SHA, GITHUB_OUTPUT (writes state=...). Exit 0 only for `valid`. Needs `gh`.
// Residual (Ruling AIR-6): the committer date is chosen by the pusher; a backdated head commit can make an older label look newer.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LABEL = 'ai-review-passed';
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });

export function labelState({ repo, pr, headSha }) {
  const labels = gh('pr', 'view', String(pr), '--json', 'labels', '--jq', '.labels[].name').split('\n');
  if (!labels.includes(LABEL)) return { state: 'absent', why: 'the label is not on the PR' };
  const times = gh('api', `repos/${repo}/issues/${pr}/timeline`, '--paginate', '--jq', `.[] | select(.event=="labeled" and .label.name=="${LABEL}") | .created_at`)
    .split('\n').filter(Boolean).map(Date.parse).filter(Number.isFinite);
  if (!times.length) return { state: 'stale', why: 'no `labeled` event for the label in the timeline' };
  const headDate = Date.parse(gh('api', `repos/${repo}/commits/${headSha}`, '--jq', '.commit.committer.date').trim());
  if (!Number.isFinite(headDate)) return { state: 'stale', why: 'the head commit date cannot be read' };
  const latest = Math.max(...times);
  return latest > headDate
    ? { state: 'valid', why: `labelled ${new Date(latest).toISOString()}, after the head commit ${new Date(headDate).toISOString()}` }
    : { state: 'stale', why: `labelled ${new Date(latest).toISOString()}, NOT after the head commit ${new Date(headDate).toISOString()}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { GH_REPO: repo, PR: pr, HEAD_SHA: headSha, GITHUB_OUTPUT } = process.env;
  if (!repo || !pr || !/^[0-9a-f]{40}$/.test(headSha ?? '')) { console.error('usage: GH_REPO=o/r PR=n HEAD_SHA=<40 hex> label-fresh.mjs'); process.exit(2); }
  let r;
  try { r = labelState({ repo, pr, headSha }); } catch (e) { r = { state: 'stale', why: `GitHub could not be read: ${e.message.split('\n')[0]}` }; } // unknown is not valid
  console.log(`label-fresh: ${r.state}: ${r.why}`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `state=${r.state}\n`);
  process.exit(r.state === 'valid' ? 0 : 1);
}
