// Consumes headless `claude -p --output-format json` output, parses the strict
// finding contract, posts inline PR comments, then decides the gate:
//   - no criticals                 -> exit 0 (pass)
//   - criticals + auto-fix enabled -> stage findings + set should_fix, exit 0
//                                     (a later workflow step pushes the fix)
//   - criticals + cannot auto-fix  -> exit 1 (block for human)
// Fails OPEN (exit 0) on every infra/parse/network error so a flaky run never
// falsely blocks a merge.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY, // owner/repo
  PR_NUMBER,
  HEAD_SHA,
  CLAUDE_OUTPUT = '/tmp/claude-out.json',
  AI_FIX_ENABLED = 'false', // 'true' only when the AI_FIX_PAT secret is present
  HEAD_IS_AI_FIX = 'false', // 'true' when HEAD is already an [ai-fix] commit
  GITHUB_OUTPUT,
} = process.env;

if (!GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN not set — skipping review (fail-open).');
  process.exit(0);
}
const repoParts = (GITHUB_REPOSITORY || '').split('/');
if (repoParts.length !== 2) {
  console.error('GITHUB_REPOSITORY missing/malformed — skipping (fail-open).');
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
const critical = findings.filter(f => f.severity === 'critical');

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

const SEV = { critical: '🔴', warning: '🟡', info: '🔵' };
const comments = findings
  .filter(f => f.file && f.line)
  .map(f => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: `${SEV[f.severity] || ''} **${String(f.severity).toUpperCase()} · ${f.category}** (Claude)\n\n${f.comment}`,
  }));
const list = findings
  .map(
    f =>
      `- ${SEV[f.severity] || ''} **${String(f.severity).toUpperCase()}** \`${f.file || '?'}:${f.line || '?'}\` (${f.category}) — ${f.comment}`
  )
  .join('\n');

const willFix = critical.length > 0 && AI_FIX_ENABLED === 'true' && HEAD_IS_AI_FIX !== 'true';

const summary =
  `### 🤖 Claude PR review\n\n${result.summary || ''}\n\n` +
  `- 🔴 critical: ${critical.length}\n` +
  `- 🟡 warning: ${findings.filter(f => f.severity === 'warning').length}\n` +
  `- 🔵 info: ${findings.filter(f => f.severity === 'info').length}\n\n` +
  (critical.length
    ? willFix
      ? '**Critical findings detected — pushing an automated fix; a fresh review will validate it.**'
      : HEAD_IS_AI_FIX === 'true'
        ? '**Critical findings remain after an automated fix — blocked for human review.**'
        : '**Blocked until the critical findings are resolved or explicitly waived.**'
    : 'No critical findings — warnings/info are advisory only.');

try {
  const rv = await gh('POST', `/repos/${owner}/${repo}/pulls/${PR_NUMBER}/reviews`, {
    commit_id: HEAD_SHA,
    event: 'COMMENT',
    body: summary,
    comments,
  });
  if (!rv.ok) {
    const fallback = await gh('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
      body: summary + (list ? `\n\n_(inline anchoring failed; findings below)_\n\n${list}` : ''),
    });
    // Same class as audit.mjs's upsertMarkerComment (#1453): gh() only
    // console.error()s a non-ok response, it never throws. If this fallback
    // ALSO fails (rate limit, missing `pull-requests: write`), the review
    // findings — including any critical ones about to block or auto-fix this
    // PR — are silently unreported anywhere a human would see them.
    if (!fallback.ok) {
      console.error(
        `::error::ai-review could not post its findings to the PR (review HTTP ${rv.status}, ` +
          `fallback comment HTTP ${fallback.status}). ${critical.length} critical finding(s) ` +
          `are unreported; only this job's log carries them.`
      );
    }
  }
} catch (e) {
  console.error('GitHub API call failed (non-fatal, fail-open):', e.message);
}

// 4. Gate / hand-off
if (critical.length === 0) {
  console.log('AI review passed (no critical findings).');
  process.exit(0);
}

if (willFix) {
  try {
    writeFileSync('/tmp/ai-fix-findings.json', JSON.stringify(critical, null, 2));
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, 'should_fix=true\n');
    console.log(`${critical.length} critical finding(s) — handing off to the auto-fix step.`);
    process.exit(0);
  } catch (e) {
    console.error('Could not stage auto-fix hand-off:', e.message);
    process.exit(1);
  }
}

console.error(
  `${critical.length} critical finding(s) — blocking (auto-fix disabled or already attempted on this HEAD).`
);
process.exit(1);
