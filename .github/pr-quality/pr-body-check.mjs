#!/usr/bin/env node
// PR-body gate (os/standard/pr-quality.md). Pure function `checkPrBody` + a CLI wrapper for the workflow.
//   always:   `## Verified`, `## Not verified`, `## Cost-if-wrong` present with real content; no hedge words
//   fix PRs:  (title `fix...` or branch `fix/...`) also `## Mutation check` with content, and a changed test file
//   learning: the PR closes an issue labelled `review-finding` -> `- [x] Test: <changed test path>` and
//             `- [x] Foundation: <path | PR url | ruling id>` (every finding makes the foundation stronger)
// CLI env: PR_QUALITY_CONFIG (path of the BASE branch's .pr-quality.json: `bodyCheckEnforceFrom` = ISO date before which problems are only
//   warnings, so adopting the check does not turn every open PR red), PR_BODY, PR_TITLE, PR_BRANCH, CHANGED_FILES (newline list), GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL.
// Exit 1 + one line per problem. Anything unreadable (issue lookup failing) is a failure: unknown is not pass.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SECTIONS = ['Verified', 'Not verified', 'Cost-if-wrong'];
const HEDGES = [/\bbest[- ]effort\b/i, /\bshould (?:just )?work\b/i, /\bprobably\b/i, /\bI think\b/i, /\bhopefully\b/i];
const PLACEHOLDER = /^(?:n\/?a|none|tbd|todo|-|\.\.\.|<[^>]*>)$/i;
export const isTestFile = (p) => /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.test\.sh$/.test(p);

/** body of `## <name>` up to the next heading, comments and blank lines removed */
export function section(body, name) {
  const re = new RegExp(`^#{2,3}\\s*${name.replace(/[-]/g, '[- ]')}\\s*$`, 'im');
  const m = re.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^#{1,3}\s/m);
  return (next < 0 ? rest : rest.slice(0, next)).replace(/<!--[\s\S]*?-->/g, '').trim();
}
const real = (s) => s !== null && s.replace(/[\s*_`>-]/g, '') !== '' && !PLACEHOLDER.test(s.trim());

export function checkPrBody({ body = '', title = '', branch = '', files = [], linkedFindings = [] }) {
  const problems = [];
  for (const name of SECTIONS) {
    const s = section(body, name);
    if (s === null) problems.push(`missing section "## ${name}"`);
    else if (!real(s)) problems.push(`section "## ${name}" is empty or a placeholder (write "Nothing" only if true, with the reason)`);
  }
  const prose = body.replace(/```[\s\S]*?```/g, '');
  for (const h of HEDGES) { const m = prose.match(h); if (m) problems.push(`hedged claim "${m[0]}": say what was measured, or put it under "Not verified"`); }
  const isFix = /^fix(\(|:|!)/i.test(title.trim()) || /^fix[/-]/i.test(branch);
  if (isFix) {
    if (!real(section(body, 'Mutation check'))) problems.push('fix PR: missing "## Mutation check" (what you reverted/broke to prove the new test FAILS on the old code, and the failing output)');
    if (!files.some(isTestFile)) problems.push('fix PR: no test file in the diff (a bug fix needs a test that fails on the old code)');
  }
  for (const n of linkedFindings) {
    const t = body.match(/^- \[x\] Test:\s*(\S.*)$/im);
    if (!t) problems.push(`closes review-finding #${n}: missing checked "- [x] Test: <path of the test>"`);
    else if (!files.some((f) => isTestFile(f) && t[1].includes(f))) problems.push(`closes review-finding #${n}: "Test:" must name a test file that is in this diff`);
    const f = body.match(/^- \[x\] Foundation:\s*(\S.*)$/im);
    if (!f || PLACEHOLDER.test(f[1].trim())) problems.push(`closes review-finding #${n}: missing checked "- [x] Foundation: <rule/guard path, foundation PR url, or ruling id>"`);
  }
  return problems;
}

/** issue numbers the body closes (Fixes/Closes/Resolves #N) */
export const closedIssues = (body) => [...new Set([...body.matchAll(/\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+#(\d+)/gi)].map((m) => Number(m[1])))];

/** epoch ms from `bodyCheckEnforceFrom` in the config file, or null when unset/unreadable (null = enforce now) */
export function enforceFrom(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')).bodyCheckEnforceFrom;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

async function main() {
  const { PR_BODY = '', PR_TITLE = '', PR_BRANCH = '', CHANGED_FILES = '', GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL = 'https://api.github.com' } = process.env;
  const linked = [];
  const problems = [];
  for (const n of closedIssues(PR_BODY)) {
    try {
      const r = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/issues/${n}`, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const issue = await r.json();
      if ((issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'review-finding')) linked.push(n);
    } catch (e) {
      problems.push(`cannot read issue #${n} to check the review-finding rule: ${e.message}`);
    }
  }
  problems.push(...checkPrBody({ body: PR_BODY, title: PR_TITLE, branch: PR_BRANCH, files: CHANGED_FILES.split('\n').map((s) => s.trim()).filter(Boolean), linkedFindings: linked }));
  if (problems.length) {
    const from = enforceFrom(process.env.PR_QUALITY_CONFIG);
    const grace = from !== null && Date.now() < from;
    for (const p of problems) console.error(grace ? `::warning::pr-body (warn-only until ${new Date(from).toISOString().slice(0, 10)}): ${p}` : `pr-body: ${p}`);
    process.exit(grace ? 0 : 1);
  }
  console.log('pr-body: ok');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
