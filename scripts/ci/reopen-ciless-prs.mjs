#!/usr/bin/env node
// G56 self-heal: GitHub sometimes drops the `pull_request` (synchronize) event for a head, so NO workflow triggered by it
// (CI, gitleaks, blast-radius, Deploy change label) runs, while the `pull_request_target` workflows (AI review, PR quality)
// still do. The merge gate then waits for checks that will never report. A close + reopen always emits a fresh event.
// Usage: node scripts/ci/reopen-ciless-prs.mjs [--repo owner/name] [--minutes 10] [--dry-run]
// Detection: open, non-draft PR into main, head commit older than N minutes, and ZERO `CI` runs for the head sha.
import { execFileSync } from 'node:child_process';

export const CI_WORKFLOW = 'CI';

/** Pure decision. prs: [{number, draft, base, headSha, headDate}], runsBySha: {sha: [{name, event}]}. */
export function findCilessPrs(prs, runsBySha, nowMs, minutes = 10) {
  return prs.filter(pr => {
    if (pr.draft || pr.base !== 'main') return false;
    if (nowMs - Date.parse(pr.headDate) < minutes * 60_000) return false;
    const runs = runsBySha[pr.headSha] ?? [];
    return !runs.some(r => r.name === CI_WORKFLOW && r.event === 'pull_request');
  });
}

const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }) || 'null');

function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const repo = opt('--repo', 'Ebda-AI-Studio/ebda-store');
  const minutes = Number(opt('--minutes', '10'));
  const dry = argv.includes('--dry-run');
  const list = gh('api', `repos/${repo}/pulls?state=open&per_page=100`);
  const prs = list.map(p => ({
    number: p.number,
    draft: p.draft,
    base: p.base.ref,
    headSha: p.head.sha,
    headDate: null,
  }));
  const runsBySha = {};
  for (const pr of prs) {
    pr.headDate = gh('api', `repos/${repo}/commits/${pr.headSha}`).commit.committer.date;
    runsBySha[pr.headSha] = gh(
      'api',
      `repos/${repo}/actions/runs?head_sha=${pr.headSha}&per_page=100`,
    ).workflow_runs.map(r => ({ name: r.name, event: r.event }));
  }
  const stuck = findCilessPrs(prs, runsBySha, Date.now(), minutes);
  for (const pr of stuck) {
    console.log(`#${pr.number} head ${pr.headSha.slice(0, 9)} has no CI run: ${dry ? 'would reopen' : 'reopening'}`);
    if (dry) continue;
    execFileSync('gh', ['pr', 'close', String(pr.number), '--repo', repo], { stdio: 'inherit' });
    execFileSync('gh', ['pr', 'reopen', String(pr.number), '--repo', repo], { stdio: 'inherit' });
  }
  if (!stuck.length) console.log('no CI-less PR heads');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
