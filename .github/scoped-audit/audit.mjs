// Consumes `claude -p --output-format json` output from the scoped-audit run.
// Parses findings, posts/upserts a single marker PR comment, appends to the
// GitHub step summary, gates on P0/P1, and files P2/P3 as tracked issues.
//
// Gate logic:
//   P0 or P1 confirmed → exit 1 (BLOCK merge)
//   P2 / P3 only       → file follow-up issues (non-blocking), exit 0
//   any infra/parse/network error → exit 0 (FAIL-OPEN — never falsely block)
//
// Modeled on .github/ai-review/review.mjs — match its style exactly.

import { readFileSync, appendFileSync } from 'node:fs';

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  PR_NUMBER,
  HEAD_SHA,
  CLAUDE_OUTPUT = '/tmp/scoped-audit-out.json',
  GITHUB_OUTPUT,
  GITHUB_STEP_SUMMARY,
} = process.env;

// --- fail-open guards ---
if (!GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN not set — skipping scoped-audit gate (fail-open).');
  process.exit(0);
}
const repoParts = (GITHUB_REPOSITORY || '').split('/');
if (repoParts.length !== 2) {
  console.error('GITHUB_REPOSITORY missing/malformed — skipping (fail-open).');
  process.exit(0);
}
if (!PR_NUMBER) {
  console.error('PR_NUMBER not set — skipping (fail-open).');
  process.exit(0);
}

const [owner, repo] = repoParts;

// ---------------------------------------------------------------------------
// 1. Read and parse Claude's JSON envelope (.result)
// ---------------------------------------------------------------------------
let modelText;
try {
  const envelope = JSON.parse(readFileSync(CLAUDE_OUTPUT, 'utf8'));
  modelText = typeof envelope === 'string' ? envelope : envelope.result;
} catch (e) {
  console.error('Could not read Claude output:', e.message);
  process.exit(0); // fail-open
}
if (!modelText) {
  console.error('Empty model result — skipping gate (fail-open).');
  process.exit(0);
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
try {
  result = JSON.parse(extractJson(modelText));
} catch (e) {
  console.error('Model did not return valid JSON:\n', modelText);
  process.exit(0); // fail-open
}

const findings = Array.isArray(result.findings) ? result.findings : [];
const p0 = findings.filter((f) => f.severity === 'P0');
const p1 = findings.filter((f) => f.severity === 'P1');
const p2 = findings.filter((f) => f.severity === 'P2');
const p3 = findings.filter((f) => f.severity === 'P3');
const blocking = [...p0, ...p1];

console.log(`scoped-audit: P0=${p0.length} P1=${p1.length} P2=${p2.length} P3=${p3.length}`);

// ---------------------------------------------------------------------------
// 2. GitHub REST helper (same style as review.mjs)
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
const PR_URL = `https://github.com/${owner}/${repo}/pull/${PR_NUMBER}`;
const MARKER = '<!-- scoped-audit-bot -->';

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
  `### Scoped Audit — ${blocking.length > 0 ? 'BLOCKED' : 'PASSED'}`,
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
    : ['_No P0/P1 findings — merge is unblocked by this gate._', ''];

const followupSection =
  p2.length + p3.length > 0
    ? [
        '#### Follow-up findings (P2/P3) — tracked as issues, non-blocking',
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
async function upsertMarkerComment(body) {
  try {
    // List existing issue comments to find the marker
    const listResp = await gh(
      'GET',
      `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments?per_page=100`
    );
    if (!listResp.ok) {
      // Can't list — just post a new one
      await gh('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, { body });
      return;
    }
    const existing = await listResp.json();
    const prior = existing.find((c) => c.body && c.body.includes(MARKER));
    if (prior) {
      await gh('PATCH', `/repos/${owner}/${repo}/issues/comments/${prior.id}`, { body });
    } else {
      await gh('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, { body });
    }
  } catch (e) {
    console.error('PR comment upsert failed (non-fatal):', e.message);
  }
}

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
  // Fetch open issues with the audit-followup label to dedup
  let openTitles = new Set();
  try {
    const resp = await gh(
      'GET',
      `/repos/${owner}/${repo}/issues?labels=audit-followup&state=open&per_page=100`
    );
    if (resp.ok) {
      const issues = await resp.json();
      for (const iss of issues) openTitles.add(iss.title);
    }
  } catch (e) {
    console.error('Could not fetch open issues for dedup (non-fatal):', e.message);
  }

  for (const f of followups) {
    const issueTitle = `[audit-followup][${f.severity}] ${f.title || 'untitled'}`;
    if (openTitles.has(issueTitle)) {
      console.log(`scoped-audit: issue already open, skipping: ${issueTitle}`);
      continue;
    }
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
    ].join('\n');

    try {
      await gh('POST', `/repos/${owner}/${repo}/issues`, {
        title: issueTitle,
        body: issueBody,
        labels: ['audit-followup', f.severity.toLowerCase()],
      });
      console.log(`scoped-audit: filed issue: ${issueTitle}`);
    } catch (e) {
      console.error(`Issue filing failed for "${issueTitle}" (non-fatal):`, e.message);
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
  process.exit(1);
}

console.log('scoped-audit: PASSED — no P0/P1 findings.');
process.exit(0);
