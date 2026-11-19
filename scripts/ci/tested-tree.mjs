#!/usr/bin/env node
/**
 * MERGE-QUEUE-1 part B: skip the full lane on a push to main when a merge group already proved the SAME TREE.
 *
 * Every merge-queue merge fires a push run that would repeat ~75 job-minutes on the tree the group just tested. This decides whether it may be
 * skipped. It compares git TREE ids (a queue squash gives a new commit sha but the same tree), requires a completed merge_group run of ci.yml
 * with conclusion success AND a `Merge queue gate` job that succeeded, and FAILS CLOSED: any API error, no matching run, ANY completed
 * non-success run of the same tree (ambiguity), a non-push event or an unreadable tree = run the full lane (skip=false).
 *
 * Output: `skip=true|false` to $GITHUB_OUTPUT (and a reason on stdout). The full-lane root jobs read it with `needs.tested-tree.outputs.skip`.
 */
import { appendFileSync } from 'node:fs';

/** Pure decision. runs = completed merge_group runs: [{ id, conclusion, tree, gate }] (gate = conclusion of the `Merge queue gate` job). */
export function decide({ event, headTree, runs }) {
  if (event !== 'push')
    return { skip: false, reason: `event ${event}: the full lane is decided by its own rules` };
  if (!headTree) return { skip: false, reason: 'head tree unreadable: full lane' };
  const same = (runs ?? []).filter(r => r.tree === headTree);
  if (same.length === 0)
    return { skip: false, reason: 'no merge group run of this tree: full lane' };
  const bad = same.filter(r => r.conclusion !== 'success' || r.gate !== 'success');
  if (bad.length)
    return {
      skip: false,
      reason: `ambiguous or failed evidence for this tree (${bad.map(r => `${r.id}:${r.conclusion}/${r.gate}`).join(', ')}): full lane`,
    };
  return {
    skip: true,
    reason: `tree ${headTree.slice(0, 8)} was proven green by merge group run ${same[0].id}: full lane skipped`,
  };
}

async function api(path, token) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}

export async function collect({ repo, sha, token, get = api }) {
  const headTree = (await get(`/repos/${repo}/git/commits/${sha}`, token))?.tree?.sha ?? null;
  const list = await get(
    `/repos/${repo}/actions/workflows/ci.yml/runs?event=merge_group&status=completed&per_page=20`,
    token
  );
  const runs = [];
  for (const r of list?.workflow_runs ?? []) {
    const tree = (await get(`/repos/${repo}/git/commits/${r.head_sha}`, token))?.tree?.sha ?? null;
    let gate = null;
    if (tree === headTree) {
      const jobs = await get(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`, token);
      gate = (jobs?.jobs ?? []).find(j => j.name === 'Merge queue gate')?.conclusion ?? null;
    }
    runs.push({ id: r.id, conclusion: r.conclusion, tree, gate });
  }
  return { headTree, runs };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const event = process.env.EVENT ?? '';
  let verdict;
  try {
    if (event !== 'push') verdict = decide({ event, headTree: null, runs: [] });
    else
      verdict = decide({
        event,
        ...(await collect({
          repo: process.env.GITHUB_REPOSITORY,
          sha: process.env.GITHUB_SHA,
          token: process.env.GITHUB_TOKEN,
        })),
      });
  } catch (e) {
    verdict = { skip: false, reason: `evidence unreadable (${e.message}): full lane` };
  }
  console.log(`tested-tree: ${verdict.reason}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `skip=${verdict.skip}\n`);
}
