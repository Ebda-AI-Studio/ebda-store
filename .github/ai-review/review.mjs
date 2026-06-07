// Consumes headless `claude -p --output-format json` output, parses the strict
// finding contract, posts inline PR comments, exits 1 only on a critical finding.
// Fails OPEN (exit 0) on every infra/parse/network error so a flaky run never
// falsely blocks a merge.
import { readFileSync } from 'node:fs';

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY, // owner/repo
  PR_NUMBER,
  HEAD_SHA,
  CLAUDE_OUTPUT = '/tmp/claude-out.json',
} = process.env;

if (!GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN not set — skipping review (fail-open).');
  process.exit(0);
}
const repoParts = (GITHUB_REPOSITORY || '').split('/');
if (repoParts.length !== 2) {
  console.error('GITHUB_REPOSITORY missing/malformed — skipping review (fail-open).');
  process.exit(0);
}
const [owner, repo] = repoParts;

// 1. Pull Claude's text result out of the CLI JSON envelope (.result field)
let modelText;
try {
  const envelope = JSON.parse(readFileSync(CLAUDE_OUTPUT, 'utf8'));
  modelText = typeof envelope === 'string' ? envelope : envelope.result;
} catch (e) {
  console.error('Could not read Claude CLI output:', e.message);
  process.exit(0); // fail-open
}
if (!modelText) {
  console.error('Empty model result — skipping gate (fail-open).');
  process.exit(0);
}

// 2. Parse the finding contract (tolerate code fences / surrounding prose)
function extractJson(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return candidate.slice(start, end + 1);
}
let result;
try {
  result = JSON.parse(extractJson(modelText));
} catch (e) {
  console.error('Model did not return valid JSON:\n', modelText);
  process.exit(0); // fail-open
}

const findings = Array.isArray(result.findings) ? result.findings : [];
const critical = findings.filter((f) => f.severity === 'critical');

// 3. Post a summary review + inline comments via GitHub REST
async function gh(method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) console.error(`gh ${method} ${path} -> ${r.status}`, await r.text());
  return r;
}

const SEV_EMOJI = { critical: '🔴', warning: '🟡', info: '🔵' };
const comments = findings
  .filter((f) => f.file && f.line)
  .map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: `${SEV_EMOJI[f.severity] || ''} **${String(f.severity).toUpperCase()} · ${f.category}** (Claude)\n\n${f.comment}`,
  }));

const findingsList = findings
  .map(
    (f) =>
      `- ${SEV_EMOJI[f.severity] || ''} **${String(f.severity).toUpperCase()}** \`${f.file || '?'}:${f.line || '?'}\` (${f.category}) — ${f.comment}`
  )
  .join('\n');

const summaryBody =
  `### 🤖 Claude PR review\n\n${result.summary || ''}\n\n` +
  `- 🔴 critical: ${critical.length}\n` +
  `- 🟡 warning: ${findings.filter((f) => f.severity === 'warning').length}\n` +
  `- 🔵 info: ${findings.filter((f) => f.severity === 'info').length}\n\n` +
  (critical.length
    ? '**Blocked until the critical findings are resolved or explicitly waived.**'
    : 'No critical findings — warnings/info are advisory only.');

// Inline review must reference the head commit. If a line isn't in the diff,
// GitHub 422s the whole review → fall back to a plain issue comment that still
// lists every finding so nothing is lost. All network/API errors fail-open.
try {
  const reviewResp = await gh(
    'POST',
    `/repos/${owner}/${repo}/pulls/${PR_NUMBER}/reviews`,
    { commit_id: HEAD_SHA, event: 'COMMENT', body: summaryBody, comments }
  );
  if (!reviewResp.ok) {
    await gh('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
      body:
        summaryBody +
        (findingsList
          ? `\n\n_(inline anchoring failed; findings listed below)_\n\n${findingsList}`
          : ''),
    });
  }
} catch (e) {
  console.error('GitHub API call failed (non-fatal, fail-open):', e.message);
}

// 4. Gate
if (critical.length > 0) {
  console.error(`${critical.length} critical finding(s) — failing the check.`);
  process.exit(1);
}
console.log('AI review passed (no critical findings).');
