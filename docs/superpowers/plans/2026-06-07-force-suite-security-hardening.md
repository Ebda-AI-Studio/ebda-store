# Force AI Suite — Security Hardening + AI PR Reviewer Implementation Plan

> **Correction (2026-09-22):** "Kuwait Law 13/2023" cited below does not exist. See docs/legal/gcc-data-protection.md for the verified GCC legal basis.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every security/quality status to "full" (no partial, none missing) across all three production apps — FWB, WBS, CRM — and add a Claude-powered PR reviewer that posts inline comments and blocks merge on critical findings.

**Architecture:** Seven independent, parallel workstreams. Each is self-contained and independently committable. A reusable "canonical file + per-repo deltas" approach keeps the three near-identical CI additions DRY. The one risky piece (WBS Postgres RLS) is internally staged: preview Neon branch → verify enforcement → prod. CRM RLS is satisfied by the correct control for a single-tenant app (role-based authz + guard test + ADR), not by bolting on Postgres RLS that would protect nothing.

**Tech Stack:** GitHub Actions, Claude Code headless CLI on a subscription OAuth token (`claude -p --output-format json`), Semgrep, GitHub CodeQL, OWASP ZAP (baseline scan action), Infisical (secret manager + rotation), Neon Postgres + Prisma (RLS), Node 20, `gh` CLI for branch protection.

---

## Corrected shared facts (verified 2026-06-07)

| Fact                    | FWB                                                                                                                                  | WBS                                                                         | CRM                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------ |
| GitHub slug             | `ForceAI-KW/force-website-builder`                                                                                                   | `ForceAI-KW/whatsapp-broadcaster`                                           | `ForceAI-KW/Force-Media-CRM`         |
| Local path              | `~/Desktop/projects/force-website-builder`                                                                                           | `~/Desktop/projects/whatsapp-bulk-sender`                                   | `~/Desktop/projects/Force_media_CRM` |
| Default branch          | `main`                                                                                                                               | `main`                                                                      | `main`                               |
| Branch protection today | **none**                                                                                                                             | **none**                                                                    | **none**                             |
| Main CI file            | `.github/workflows/ci.yml`                                                                                                           | `.github/workflows/pr-validation.yml` (PR) + `production-deploy.yml` (push) | `.github/workflows/ci.yml`           |
| `runs-on` selector      | `${{ (inputs.force_cloud \|\| vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' \|\| fromJSON('["self-hosted","linux","wsl2"]') }}` | same                                                                        | same                                 |
| Tenancy                 | multi-tenant (store)                                                                                                                 | multi-tenant (client)                                                       | **single-org (role-based)**          |
| RLS today               | full (`force_app` role + `SET LOCAL app.current_store_id`)                                                                           | 3 tables only, **app connects as DB owner**                                 | none (correct — single tenant)       |
| DB client               | Prisma 6 / Neon                                                                                                                      | Prisma 5 / Neon                                                             | Prisma 6 / Neon                      |

**Prerequisite secrets (set once, all repos):** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` on Ahmad's subscription — for the AI reviewer; no API key, uses the subscription), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID` (already present), `INFISICAL_MACHINE_TOKEN` + `INFISICAL_PROJECT_ID` (set during WS-D), `NEON_API_KEY` + Neon project IDs (for rotation, WS-D).

**Working discipline for every workstream:** create a feature branch off `main`; confirm `git config user.email` is `ahmed0montaser@gmail.com` and HEAD author matches before any push that triggers a Vercel deploy; never `git add -A`; commit specific paths.

**Runner flow (applies to every new workflow):** all new CI compute jobs (`ai-review`, `codeql`, `semgrep`, `zap`, `secret-rotation`) use the existing self-hosted + cloud-fallback selector verbatim — `runs-on: ${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}` — so they run on the WSL2 box when `vars.USE_SELF_HOSTED=true` and fall back to cloud otherwise, identical to `ci.yml`/`pr-validation.yml`. Workflows that expose a manual trigger also carry the standard `workflow_dispatch.inputs.force_cloud` boolean; on `pull_request`/`push`/`schedule` triggers `inputs.force_cloud` is simply undefined (falsy) and the `USE_SELF_HOSTED` var decides. Offline-box behavior is handled by the existing `cloud-rescue.yml`, same as today — no new workflow is hardcoded to `ubuntu-latest` except where it mirrors the existing `notify-failure` pattern (none added here).

---

## Target status matrix (definition of done)

Every cell must be ✅ at the end. Mapping of cell → workstream:

| Control                                       | FWB            | WBS                      | CRM                            | Workstream |
| --------------------------------------------- | -------------- | ------------------------ | ------------------------------ | ---------- |
| AI PR reviewer (inline, critical-blocks)      | WS-A           | WS-A                     | WS-A                           | A          |
| SAST (Semgrep + CodeQL)                       | WS-B           | WS-B                     | WS-B                           | B          |
| DAST (ZAP in CI) + manual Burp doc            | WS-C           | WS-C                     | WS-C                           | C          |
| Secret manager + rotation                     | WS-D           | WS-D                     | WS-D                           | D          |
| RLS / tenant isolation                        | verify (WS-E0) | full RLS (WS-E1)         | role-authz guard + ADR (WS-E2) | E          |
| Security headers (HSTS/CSP/nosniff/frame)     | verify (WS-F0) | frontend headers (WS-F1) | headers (WS-F2)                | F          |
| Branch protection: tests + AI review required | WS-G           | WS-G                     | WS-G                           | G          |
| Severity threshold consistent (audit low)     | already        | fix moderate→low (WS-G3) | already                        | G          |

---

# Workstream A — Claude AI PR Reviewer

**Files (per repo):**

- Create: `.github/workflows/ai-review.yml`
- Create: `.github/ai-review/review.mjs` (parse + post-comments + gate; Node 20 built-ins only)
- Create: `.github/ai-review/prompt.md` (the architecture-level review instructions)

**Auth:** uses Ahmad's **Claude subscription**, not an API key. A long-lived OAuth token from `claude setup-token` is stored as the repo secret `CLAUDE_CODE_OAUTH_TOKEN`; the workflow runs headless `claude -p --output-format json`, which honors that token in CI (no prior `claude login` needed).

**Design:** On `pull_request`, the workflow checks out the PR, computes the diff vs the base branch, pipes it + the review instructions to `claude -p --output-format json`. Then `review.mjs` reads the model text from the CLI's `.result` field, parses the strict JSON finding contract, (1) posts each finding as an inline review comment via the GitHub API and (2) exits non-zero **only if any finding is severity `critical`**. `warning`/`info` findings are posted but never fail the job. The job is later made a **required status check** in WS-G, which is what actually blocks merge.

> **Cost/ToS note (verified 2026-06-07):** automated CI usage of a subscription token is permitted (GitHub Actions + headless `claude -p` is explicitly allowed; the OAuth restriction only bites third-party/Agent-SDK products). But since **2026-06-15**, headless/CI usage draws from a separate monthly **Agent credit** (Pro ~$20, Max 5× ~$100, Max 20× ~$200) and bills at API rates once exhausted — interactive terminal/desktop use stays on the normal subscription window. A per-PR reviewer is light; the workflow pins `--model claude-opus-4-8` for the security gate (swap to `claude-sonnet-4-6` to conserve credit).

### Task A1: Author the reviewer system prompt

- [ ] **Step 1: Create the prompt file** (identical across all three repos)

Create `.github/ai-review/prompt.md`:

```markdown
You are a senior staff engineer reviewing a pull request diff for a production
multi-tenant SaaS. Review for ARCHITECTURE AND CORRECTNESS, not style.

INCLUDE (these are what break in production, not in a linter):

- Business-logic correctness: does the change do what it claims, including the
  unhappy paths?
- SQL injection / unsanitized input reaching a query, raw SQL, or `$queryRawUnsafe`.
- Unhandled edge cases: null/undefined, empty arrays, missing await, partial
  failure (step 2 fails after step 1 committed), race conditions, redelivery/retry
  double-effects on external side effects (payments, WhatsApp/Meta sends, email).
- N+1 queries and obviously unindexed hot-path queries.
- Anything touching AUTH, PAYMENTS, or DATA DELETION — flag for extra scrutiny
  even if it looks correct, and say why it is or isn't safe.
- Tenant-isolation regressions: a query missing its store_id/client_id scope, a
  silent "default to first tenant" fallback, RLS bypass.
- Secret/PII leakage in logs, error responses, or client payloads.

IGNORE:

- Formatting, naming, import order, quote style, "could be cleaner" — anything a
  linter or prettier already owns. Do not comment on style.

SEVERITY RUBRIC:

- "critical": will cause incorrect behavior, data loss, a security hole, or a
  production outage if merged. Be conservative — only use when you are confident.
- "warning": real risk or smell that a human should look at, but not a guaranteed
  break.
- "info": context worth knowing; never blocks.

OUTPUT CONTRACT: respond with ONLY a JSON object, no prose, matching:
{
"summary": "<2-3 sentence overall read of the PR>",
"findings": [
{
"file": "<path exactly as in the diff>",
"line": <integer line number in the NEW file, from the diff hunk>,
"severity": "critical" | "warning" | "info",
"category": "logic" | "sql-injection" | "edge-case" | "n+1" |
"auth" | "payments" | "deletion" | "tenant-isolation" |
"secret-leak" | "other",
"comment": "<what is wrong and the concrete consequence in production>"
}
]
}
If the diff is safe, return an empty findings array. Never invent line numbers;
if unsure of the exact line, pick the closest changed line in that file.
```

- [ ] **Step 2: Commit**

```bash
git add .github/ai-review/prompt.md
git commit -m "feat(ci): add ai-review system prompt"
```

### Task A2: (no extra dependencies)

The reviewer parses the Claude CLI's JSON output and calls the GitHub REST API using Node 20 built-ins (`fetch`, `fs`, `child_process`) only — there is no npm package to install or pin. Claude itself is installed globally in the workflow via `@anthropic-ai/claude-code`. Skip straight to A3.

### Task A3: Write the reviewer script

- [ ] **Step 1: Create `.github/ai-review/review.mjs`** (identical across repos)

````javascript
// Consumes headless `claude -p --output-format json` output, parses the strict
// finding contract, posts inline PR comments, exits 1 only on a critical finding.
import { readFileSync } from 'node:fs';

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY, // owner/repo
  PR_NUMBER,
  HEAD_SHA,
  CLAUDE_OUTPUT = '/tmp/claude-out.json',
} = process.env;

if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
const [owner, repo] = GITHUB_REPOSITORY.split('/');

// 1. Pull Claude's text result out of the CLI JSON envelope (.result field)
let modelText;
try {
  const envelope = JSON.parse(readFileSync(CLAUDE_OUTPUT, 'utf8'));
  modelText = typeof envelope === 'string' ? envelope : envelope.result;
} catch (e) {
  console.error('Could not read Claude CLI output:', e.message);
  process.exit(0); // fail-open: never block a merge on infra error
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

const SEV_EMOJI = { critical: '🔴', warning: '🟡', info: '🔵' };
const comments = findings
  .filter(f => f.file && f.line)
  .map(f => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: `${SEV_EMOJI[f.severity] || ''} **${String(f.severity).toUpperCase()} · ${f.category}** (Claude)\n\n${f.comment}`,
  }));

const summaryBody =
  `### 🤖 Claude PR review\n\n${result.summary || ''}\n\n` +
  `- 🔴 critical: ${critical.length}\n` +
  `- 🟡 warning: ${findings.filter(f => f.severity === 'warning').length}\n` +
  `- 🔵 info: ${findings.filter(f => f.severity === 'info').length}\n\n` +
  (critical.length
    ? '**Blocked until the critical findings are resolved or explicitly waived.**'
    : 'No critical findings — warnings/info are advisory only.');

// Inline review must reference the head commit. If a line isn't in the diff,
// GitHub 422s the whole review → fall back to a plain issue comment.
const reviewResp = await gh('POST', `/repos/${owner}/${repo}/pulls/${PR_NUMBER}/reviews`, {
  commit_id: HEAD_SHA,
  event: 'COMMENT',
  body: summaryBody,
  comments,
});
if (!reviewResp.ok) {
  await gh('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
    body: summaryBody + '\n\n_(inline anchoring failed; findings summarized above)_',
  });
}

// 4. Gate
if (critical.length > 0) {
  console.error(`${critical.length} critical finding(s) — failing the check.`);
  process.exit(1);
}
console.log('AI review passed (no critical findings).');
````

- [ ] **Step 2: Commit**

```bash
git add .github/ai-review/review.mjs
git commit -m "feat(ci): claude pr reviewer script (inline comments, critical gate)"
```

### Task A4: Write the workflow

- [ ] **Step 1: Create `.github/ai-review/`-driving workflow `.github/workflows/ai-review.yml`**

```yaml
name: AI Review

on:
  pull_request:
    branches: [main]

concurrency:
  group: ai-review-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  ai-review:
    name: Claude PR review
    runs-on: ${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code
      - name: Build review input (instructions + diff)
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          {
            cat .github/ai-review/prompt.md
            echo
            echo "PR unified diff follows. Review per the contract above and respond with ONLY the JSON object."
            echo
            git diff "$BASE_SHA...$HEAD_SHA" -- . \
              ':(exclude)**/package-lock.json' ':(exclude)**/*.lock' \
              ':(exclude)**/dist/**' ':(exclude)**/.next/**' ':(exclude)**/*.snap' \
              | head -c 200000
          } > /tmp/review-input.md
      - name: Run Claude review (subscription OAuth)
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          claude -p --output-format json \
            --model claude-opus-4-8 \
            --allowedTools "Read,Grep,Glob" \
            < /tmp/review-input.md > /tmp/claude-out.json
          cat /tmp/claude-out.json
      - name: Parse, comment, gate
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          CLAUDE_OUTPUT: /tmp/claude-out.json
        run: node .github/ai-review/review.mjs
```

> Note: uses the standard self-hosted + cloud-fallback selector (matches `ci.yml`). On a `pull_request` trigger `inputs.force_cloud` is undefined → evaluates falsy → falls back to `vars.USE_SELF_HOSTED`, exactly like the existing CRM `ci.yml`. If the WSL box is offline with `USE_SELF_HOSTED=true`, the existing `cloud-rescue.yml` path covers it like every other job.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ai-review.yml
git commit -m "feat(ci): ai-review workflow (pr trigger, write pull-requests perm)"
```

### Task A5: Set the subscription OAuth secret + verify on a throwaway PR

- [ ] **Step 1: Generate the token (Ahmad, local, once)**

Run: `claude setup-token` — authenticates against the Claude subscription and prints a long-lived OAuth token (`sk-ant-oat01-...`, ~1 year). This is the only step that needs Ahmad's hands.

- [ ] **Step 2: Set the secret** (per repo; replace SLUG)

Run: `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ForceAI-KW/<SLUG>` (paste the token when prompted)
Expected: `✓ Set ...`. Verify with `gh secret list --repo ForceAI-KW/<SLUG> | grep CLAUDE_CODE_OAUTH_TOKEN`.

- [ ] **Step 3: Open a test PR with a deliberate critical bug**

Create a branch that introduces, e.g., a raw `prisma.$queryRawUnsafe(\`... ${userInput}\`)`in a scratch file, push, open PR.
Expected: the`ai-review`check runs, posts an inline comment flagging`sql-injection` as critical, and the check is **red**.

- [ ] **Step 4: Fix the bug in the same PR, push**

Expected: re-run posts "No critical findings", check goes **green**. Close the test PR without merging.

### Per-repo deltas for Workstream A

- **WBS**: identical; the diff command already covers `backend/` + `frontend/`.
- **CRM**: identical.
- All three get the same three files (`ai-review.yml`, `review.mjs`, `prompt.md`) byte-for-byte. Each repo needs its own `CLAUDE_CODE_OAUTH_TOKEN` secret (same token value is fine).

---

# Workstream B — SAST (Semgrep + CodeQL)

**Files (per repo):**

- Create: `.github/workflows/codeql.yml`
- Create: `.github/workflows/semgrep.yml`

### Task B1: CodeQL workflow

- [ ] **Step 1: Create `.github/workflows/codeql.yml`** (FWB/CRM = `javascript-typescript`)

```yaml
name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 3 * * 1' # weekly Monday 03:00 UTC

concurrency:
  group: codeql-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  analyze:
    name: CodeQL analyze
    runs-on: ${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
    timeout-minutes: 20
    permissions:
      security-events: write
      contents: read
      actions: read
    strategy:
      matrix:
        language: [javascript-typescript]
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          language: ${{ matrix.language }}
          queries: security-extended
      - uses: github/codeql-action/analyze@v3
        with:
          category: '/language:${{ matrix.language }}'
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/codeql.yml
git commit -m "feat(ci): codeql security-extended scan (push/pr/weekly)"
```

### Task B2: Semgrep workflow

- [ ] **Step 1: Create `.github/workflows/semgrep.yml`**

```yaml
name: Semgrep

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: semgrep-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  semgrep:
    name: Semgrep SAST
    runs-on: ${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
    timeout-minutes: 10
    container:
      image: semgrep/semgrep:1.90.0
    steps:
      - uses: actions/checkout@v4
      - name: Run Semgrep (block on error-severity)
        run: |
          semgrep ci \
            --config p/default \
            --config p/owasp-top-ten \
            --config p/javascript \
            --config p/typescript \
            --config p/secrets \
            --error \
            --severity ERROR
        env:
          SEMGREP_RULES: ''
```

> `--error --severity ERROR` makes only ERROR-severity findings fail the job (the "critical blocks, lower is informational" posture for SAST). WARN findings still print in logs.
> Container job (`semgrep/semgrep` image) + ZAP both need Docker on the runner. The WSL2 self-hosted box already runs Docker (your CI integration tests use service containers), so the selector is safe; when it routes to cloud, containers are native. If a self-hosted box ever lacks Docker, set `vars.USE_SELF_HOSTED=false` or dispatch with `force_cloud=true`.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/semgrep.yml
git commit -m "feat(ci): semgrep owasp-top-ten + secrets sast (block on ERROR)"
```

### Per-repo deltas for Workstream B

- **WBS**: identical CodeQL (`javascript-typescript` covers backend JS + frontend TS). Semgrep `p/javascript` already covers `backend/`.
- **CRM**: identical.
- CodeQL requires GitHub code scanning enabled (free for these private repos under the org plan — if `init` errors with "Advanced Setup not enabled", enable code scanning in repo Settings → Security → Code scanning → "Set up → Advanced" once, then the workflow drives it).

---

# Workstream C — DAST (OWASP ZAP in CI) + manual Burp checklist

**Files (per repo):**

- Create: `.github/workflows/zap-baseline.yml`
- Create: `.zap/rules.tsv` (alert tuning: ignore known-safe)
- Create: `docs/security/burp-manual-pentest-checklist.md` (shared content)

**Design:** ZAP baseline scan (passive + light active) runs nightly + on-demand against the **staging/preview** URL (never prod write paths). It fails on `FAIL`-level alerts; `WARN` are informational. Burp stays a quarterly human pass driven by a checklist doc.

### Task C1: ZAP alert tuning file

- [ ] **Step 1: Create `.zap/rules.tsv`** (tab-separated; start permissive, tighten later)

```
# ruleId	action	(ignore|warn|fail)	url-regex
10096	IGNORE	# Timestamp disclosure - noisy, not a real risk here
10027	IGNORE	# Information disclosure - suspicious comments (false positives in minified JS)
```

- [ ] **Step 2: Commit**

```bash
git add .zap/rules.tsv
git commit -m "chore(security): zap baseline alert tuning"
```

### Task C2: ZAP baseline workflow

- [ ] **Step 1: Create `.github/workflows/zap-baseline.yml`** (set `ZAP_TARGET` per repo)

```yaml
name: ZAP Baseline DAST

on:
  schedule:
    - cron: '0 2 * * *' # nightly 02:00 UTC
  workflow_dispatch:
    inputs:
      target:
        description: 'URL to scan (defaults to repo ZAP_TARGET var)'
        required: false
        type: string
      force_cloud:
        description: 'Run on cloud (ubuntu-latest) instead of self-hosted'
        type: boolean
        default: false

permissions:
  contents: read
  issues: write

jobs:
  zap:
    name: ZAP baseline
    runs-on: ${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - name: ZAP Baseline Scan
        uses: zaproxy/action-baseline@v0.12.0
        with:
          target: ${{ github.event.inputs.target || vars.ZAP_TARGET }}
          rules_file_name: '.zap/rules.tsv'
          cmd_options: '-a -I'
          allow_issue_writing: true
          fail_action: true
```

> `-I` = do not fail on WARN; `fail_action: true` + a `FAIL`-classified alert (via `rules.tsv`) is what reds the job. `allow_issue_writing` files a GitHub issue with the report.

- [ ] **Step 2: Set the target variable** (per repo)

Run: `gh variable set ZAP_TARGET --repo ForceAI-KW/<SLUG> --body "<staging-or-preview-url>"`

- FWB: a Vercel **preview** storefront URL (never `wadyaljuz.com` prod).
- WBS: `https://ws.forcemediakw.com` is prod — prefer a Vercel preview URL; if none, scan the prod **read** surface only (baseline is passive-leaning; `-a` adds light active — keep it pointed at staging).
- CRM: a Vercel preview URL for `crm.forcemediakw.com`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/zap-baseline.yml
git commit -m "feat(ci): owasp zap baseline dast (nightly + dispatch)"
```

### Task C3: Manual Burp checklist (shared doc)

- [ ] **Step 1: Create `docs/security/burp-manual-pentest-checklist.md`**

```markdown
# Manual Burp Suite Pentest Checklist (quarterly)

Run with Burp Suite Community against a **staging/preview** environment. Log
findings as GitHub issues labelled `security`. Cadence: quarterly + after any
auth/payments/deletion change.

## Setup

1. Configure Burp proxy, import the app's CA, browse the full authenticated app
   so the site map populates.
2. Scope: limit to the staging host only.

## Auth

- [ ] Session token entropy + rotation on login/logout (no fixation).
- [ ] JWT: tamper `alg`, swap `storeId`/`clientId` claim, expired token → 401.
- [ ] Password reset token single-use + expires; no user enumeration on forgot.
- [ ] IDOR: change a resource id/UUID in a request to another tenant's → 404 not 403.

## Tenant isolation

- [ ] Replace `X-Store-ID` / `client_id` with another tenant's → no cross-tenant data.
- [ ] Remove the tenant header entirely → 400, never "default to first tenant".

## Injection

- [ ] SQLi probes on every filter/search/sort param (Burp Intruder).
- [ ] XSS reflected/stored on every free-text field that renders in admin/storefront.
- [ ] Open redirect on any `returnTo`/`actionUrl`/`next` param.

## Payments / deletion

- [ ] Replay a payment webhook; confirm idempotency (no double credit).
- [ ] Tamper amount/currency in checkout init.
- [ ] Account deletion / data erasure actually removes PII (GDPR/Kuwait Law 13).

## Headers / transport

- [ ] HSTS, CSP, X-Content-Type-Options, X-Frame-Options present on every host.
- [ ] No secret/PII in responses or error bodies.

## Sign-off

- Date / tester / staging build SHA / issues filed: \***\*\*\*\*\***\_\_\***\*\*\*\*\***
```

- [ ] **Step 2: Commit**

```bash
git add docs/security/burp-manual-pentest-checklist.md
git commit -m "docs(security): quarterly manual burp pentest checklist"
```

### Per-repo deltas for Workstream C

- Doc is byte-identical across repos. Workflow differs only by the `ZAP_TARGET` variable value. WBS doc lives at `docs/security/` (create dir).

---

# Workstream D — Secret Manager (Infisical) + Rotation

**Why Infisical:** free tier includes native secret rotation; integrates by **syncing secrets into the Railway/Vercel env vars the apps already read**, so there is no cutover gap (zero-downtime: keep existing provider env vars until parity is verified, then let Infisical own them).

**Files:**

- Create (each repo): `.infisical.json` (project link)
- Create (each repo): `docs/security/SECRETS.md` (inventory + rotation runbook)
- Create (central, in FWB repo): `scripts/security/rotate-secrets.mjs` (the auto-rotation engine)
- Create (each repo): `.github/workflows/secret-rotation.yml` (scheduled rotation of the safe set)

### Task D1: Provision Infisical + import existing secrets (zero-downtime)

- [ ] **Step 1: Create the Infisical org + one project per app** (UI or CLI)

Run: `npx @infisical/cli@latest login` then `infisical init` inside each repo → writes `.infisical.json`.
Expected: `.infisical.json` with `workspaceId` per repo.

- [ ] **Step 2: Import current env into Infisical without changing runtime**

For each environment (dev/staging/prod) pull current values from the provider and push to Infisical:
Run (example, prod): pull names from `railway variables --json` (WBS/FWB-api) and `vercel env ls` (front ends), then `infisical secrets set <NAME>=<VALUE> --env=prod`.
Expected: Infisical prod env mirrors every name in the per-repo inventory (WS-D SECRETS.md). **Do not delete provider vars yet.**

- [ ] **Step 3: Enable Infisical → Railway and Infisical → Vercel native integrations**

Configure each integration to **sync** the Infisical prod env into the existing Railway service / Vercel project env. Trigger a redeploy. Verify the app boots and a smoke request succeeds (FWB: load a store page; WBS: webhook health; CRM: `/login`).
Expected: app green on Infisical-sourced values.

- [ ] **Step 4: Commit the link file (no secrets)**

```bash
git add .infisical.json
git commit -m "chore(security): link repo to infisical project"
```

### Task D2: Document the inventory + classification

- [ ] **Step 1: Create `docs/security/SECRETS.md`** per repo, listing every secret NAME, its owner/provider, and `rotation: auto | manual | n/a`. Use the verified inventories:

FWB rotatable-auto set: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `REVIEW_TOKEN_SECRET`, `VAPID_PUBLIC_KEY`+`VAPID_PRIVATE_KEY`, `ALERTS_WEBHOOK_TOKEN`. Manual (provider): `GOOGLE_GENERATIVE_AI_KEY`/`GEMINI_API_KEY`, `RESEND_API_KEY`, all `TAP_*`/`MYFATOORAH_*`/`HESABE_*`/`UPAYMENTS_*`, `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`, `ONESIGNAL_*`, `SENTRY_DSN*`, `FORCE_AI_META_*`, `VERCEL_API_TOKEN`, `TELEGRAM_BOT_TOKEN`.

WBS rotatable-auto set: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` (rotation = re-encrypt rows; see runbook), `NEXTAUTH_SECRET` (if used), `ALERTS_WEBHOOK_TOKEN`, `LOAD_TEST_BYPASS_TOKEN`, `META_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `INNGEST_RECEIVER_SECRET`. Manual: `WHATSAPP_TOKEN`, `META_APP_SECRET`, `FACEBOOK_APP_SECRET`, all `R2_*`, `RESEND_API_KEY`, `SENTRY_DSN`, `AXIOM_TOKEN`, `ONESIGNAL_*`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`.

CRM rotatable-auto set: `DATABASE_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`. Manual: `GROQ_API_KEY`, `ONESIGNAL_*`, `GOOGLE_SHEETS_CREDENTIALS_PATH`.

Each manual entry gets a one-line "how to rotate at the provider" note.

- [ ] **Step 2: Commit**

```bash
git add docs/security/SECRETS.md
git commit -m "docs(security): secret inventory + rotation classification"
```

### Task D3: The rotation engine (auto-safe set)

- [ ] **Step 1: Create `scripts/security/rotate-secrets.mjs`** (in FWB; WBS/CRM get a tailored copy)

```javascript
// Rotates the SAFE set only. Strategy per secret type:
//  - random-token (JWT_SECRET, *_WEBHOOK_TOKEN, CRON_SECRET): generate new 32B,
//    write to Infisical, sync triggers provider redeploy. For signing secrets,
//    support a dual-key window if the app reads *_NEW (see CREDENTIAL_ENCRYPTION_KEY).
//  - neon-db (DATABASE_URL/DIRECT_URL): rotate the Neon role password via Neon API,
//    rebuild the connection string, write both pooled + direct to Infisical.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ENV = process.env.INFISICAL_ENV || 'prod';
const DRY = process.env.DRY_RUN !== 'false'; // default dry-run

const RANDOM_TOKENS = (process.env.ROTATE_TOKENS || '').split(',').filter(Boolean);

function setSecret(name, value) {
  if (DRY) return console.log(`[dry-run] would set ${name} (${value.length}b)`);
  execSync(`infisical secrets set ${name}=${value} --env=${ENV}`, {
    stdio: 'inherit',
  });
}

// 1. Random tokens
for (const name of RANDOM_TOKENS) {
  setSecret(name, randomBytes(32).toString('base64'));
}

// 2. Neon DB password rotation (requires NEON_API_KEY + NEON_PROJECT_ID + role)
if (process.env.ROTATE_NEON === 'true') {
  const { NEON_API_KEY, NEON_PROJECT_ID, NEON_BRANCH_ID, NEON_ROLE } = process.env;
  const r = await fetch(
    `https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches/${NEON_BRANCH_ID}/roles/${NEON_ROLE}/reset_password`,
    { method: 'POST', headers: { Authorization: `Bearer ${NEON_API_KEY}` } }
  );
  if (!r.ok) throw new Error(`Neon rotate failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const pw = data.role.password;
  const host = process.env.NEON_HOST; // pooled host
  const directHost = process.env.NEON_DIRECT_HOST;
  const db = process.env.NEON_DB || 'neondb';
  setSecret('DATABASE_URL', `postgresql://${NEON_ROLE}:${pw}@${host}/${db}?sslmode=require`);
  setSecret('DIRECT_URL', `postgresql://${NEON_ROLE}:${pw}@${directHost}/${db}?sslmode=require`);
}

console.log(DRY ? 'Dry run complete.' : 'Rotation complete.');
```

> `CREDENTIAL_ENCRYPTION_KEY` (WBS) is intentionally NOT in this script's blind path — its rotation requires the dual-key re-encrypt flow (`CREDENTIAL_ENCRYPTION_KEY_NEW` already exists in source). Document that as a guided runbook step in SECRETS.md, not an unattended job.

- [ ] **Step 2: Smoke the engine in dry-run**

Run: `ROTATE_TOKENS=ALERTS_WEBHOOK_TOKEN node scripts/security/rotate-secrets.mjs`
Expected: prints `[dry-run] would set ALERTS_WEBHOOK_TOKEN ...`, exits 0, changes nothing.

- [ ] **Step 3: Commit**

```bash
git add scripts/security/rotate-secrets.mjs
git commit -m "feat(security): secret rotation engine (random tokens + neon, dry-run default)"
```

### Task D4: Scheduled rotation workflow + reminders

- [ ] **Step 1: Create `.github/workflows/secret-rotation.yml`**

```yaml
name: Secret Rotation

on:
  schedule:
    - cron: '0 4 1 */3 *' # 04:00 UTC, 1st of every 3rd month (quarterly)
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run (no writes)'
        type: boolean
        default: true
      force_cloud:
        description: 'Run on cloud (ubuntu-latest) instead of self-hosted'
        type: boolean
        default: false

permissions:
  contents: read

jobs:
  rotate-safe-set:
    name: Rotate auto-safe secrets
    runs-on: ${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install Infisical CLI
        run: npm i -g @infisical/cli@latest
      - name: Rotate
        env:
          INFISICAL_TOKEN: ${{ secrets.INFISICAL_MACHINE_TOKEN }}
          INFISICAL_ENV: prod
          DRY_RUN: ${{ github.event.inputs.dry_run || 'false' }}
          ROTATE_TOKENS: ${{ vars.ROTATE_TOKENS }}
          ROTATE_NEON: ${{ vars.ROTATE_NEON }}
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
          NEON_PROJECT_ID: ${{ vars.NEON_PROJECT_ID }}
          NEON_BRANCH_ID: ${{ vars.NEON_BRANCH_ID }}
          NEON_ROLE: ${{ vars.NEON_ROLE }}
          NEON_HOST: ${{ vars.NEON_HOST }}
          NEON_DIRECT_HOST: ${{ vars.NEON_DIRECT_HOST }}
        run: node scripts/security/rotate-secrets.mjs
      - name: Reminder for manual-rotation secrets
        if: always()
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_ALERT_CHAT_ID: ${{ secrets.TELEGRAM_ALERT_CHAT_ID }}
        run: |
          [ -z "$TELEGRAM_BOT_TOKEN" ] && exit 0
          curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="${TELEGRAM_ALERT_CHAT_ID}" -d parse_mode=Markdown \
            --data-urlencode text="🔑 Quarterly secret rotation ran on ${{ github.repository }}. Auto-safe set rotated. MANUAL action needed for provider keys — see docs/security/SECRETS.md (Meta/WhatsApp, R2, Resend, OneSignal, payment gateways, Groq/Gemini)." >/dev/null
```

- [ ] **Step 2: Set machine token + Neon vars** per repo (`gh secret set INFISICAL_MACHINE_TOKEN`, `gh secret set NEON_API_KEY`, `gh variable set ROTATE_TOKENS --body "..."`, etc.)

- [ ] **Step 3: Manual dispatch in dry-run to verify**

Run: `gh workflow run secret-rotation.yml --repo ForceAI-KW/<SLUG> -f dry_run=true`
Expected: green run, logs show `[dry-run]` lines, Telegram reminder received.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/secret-rotation.yml
git commit -m "feat(security): quarterly secret rotation workflow + manual-key reminder"
```

### Per-repo deltas for Workstream D

- **WBS**: `rotate-secrets.mjs` copied to `backend/scripts/security/` OR root `scripts/`; `ROTATE_TOKENS` = WBS safe set; add the `CREDENTIAL_ENCRYPTION_KEY` dual-key runbook section to SECRETS.md (do NOT auto-rotate). Two Railway services (backend + worker) both pull from Infisical → ensure both integrations are wired.
- **CRM**: `ROTATE_TOKENS` = `NEXTAUTH_SECRET,CRON_SECRET`; Neon rotation optional; Vercel-only (no Railway integration).
- **FWB**: API on Railway + two Vercel front ends → three sync targets.

---

# Workstream E — RLS / Tenant Isolation

## WS-E0 (FWB): verify already-full RLS

### Task E0: Add an RLS-enforcement integration test (guards against regressions)

**Files:** Create `tests/integration/rls-enforcement.test.ts`

- [ ] **Step 1: Write the failing test** — connect as the app role with `app.current_store_id` set to store A, attempt to read store B's products, assert zero rows.

```typescript
import { describe, it, expect } from 'vitest';
import { runInTenantContext } from '@ebda/database';
// seed two stores A,B with one product each in beforeAll (reuse existing helpers)
describe('RLS enforcement', () => {
  it('cannot read another store rows under tenant context', async () => {
    const rows = await runInTenantContext(STORE_A_ID, async () => {
      const { getTx } = await import('@ebda/database');
      return getTx().product.findMany({ where: { storeId: STORE_B_ID } });
    });
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → expect PASS** (FWB RLS already works). Run: `npx vitest run tests/integration/rls-enforcement.test.ts`. If it FAILS, RLS has a hole → fix before proceeding.
- [ ] **Step 3: Commit** `test(rls): regression guard for store isolation`.

## WS-E1 (WBS): full Postgres RLS — internally staged

> **This is the high-blast-radius piece.** WBS connects as the DB owner, which bypasses RLS. Enforcement requires FWB's pattern: a dedicated non-owner `force_app` role + `FORCE ROW LEVEL SECURITY`. Staged: preview Neon branch → verify → prod.

**Tenant tables needing RLS** (have `client_id`, currently unprotected): `campaigns`, `campaign_messages`, `contacts`, `conversations`, `wa_carts`, `conversions`, `link_clicks`, `link_tracking`, `media_files`, `message_history`, `message_templates`, `notifications`, `segments`, `templates`, `user_profiles`, `webhook_events`, `bot_events`, `client_features`, `client_audit_logs`, `message_idempotency_keys`. Indirect (scope via FK): `campaign_recipients`, `contact_collection_memberships`, `segment_contacts`, `user_roles`.

### Task E1a: Create a preview Neon branch + dedicated app role

- [ ] **Step 1: Create a throwaway Neon branch** `rls-test` off production (respects the 10-branch cap — delete after).

Run: `neonctl branches create --project-id <WBS_PROJECT> --name rls-test`
Expected: branch created; capture its connection string.

- [ ] **Step 2: Write migration `backend/prisma/migrations/<ts>_create_force_app_role/migration.sql`**

```sql
-- Dedicated non-owner role the app connects as, so RLS actually applies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'force_app') THEN
    CREATE ROLE force_app NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO force_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO force_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO force_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO force_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO force_app;
```

> The app's `DATABASE_URL` must then connect as a login role that has `force_app` (or set `role force_app`). On Neon, create a login user and `GRANT force_app TO <login_user>`; the connection runs `SET ROLE force_app` OR the login user is non-superuser and `FORCE RLS` covers it. Decide in Step 3.

- [ ] **Step 3: Apply to the preview branch only + verify the role exists**

Run against the `rls-test` branch URL: `DATABASE_URL=<rls-test-url> npx prisma migrate deploy`
Expected: role created. Verify: `psql <rls-test-url> -c "\du force_app"`.

### Task E1b: RLS policies migration (replicate the proven 3-table template across all tenant tables)

- [ ] **Step 1: Write migration `<ts>_rls_all_tenant_tables/migration.sql`** using the exact pattern from `20260522080000_rls_conversation_notes_tags`. Direct-`client_id` tables:

```sql
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaigns
  USING (client_id::text = current_setting('app.current_client_id', true))
  WITH CHECK (client_id::text = current_setting('app.current_client_id', true));
-- ... repeat for every direct-client_id table listed above ...
```

Indirect tables (no `client_id` column) use the EXISTS form against their parent, e.g.:

```sql
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_recipients
  USING (EXISTS (SELECT 1 FROM campaigns c
                 WHERE c.id = campaign_recipients.campaign_id
                 AND c.client_id::text = current_setting('app.current_client_id', true)));
```

> `FORCE ROW LEVEL SECURITY` is the critical addition vs FWB-era migrations — it makes even the table owner obey policies (so a missed role switch doesn't silently disable isolation). Tables the platform must read cross-tenant (admin) keep working via a bypass: the admin path issues `SET LOCAL app.current_client_id` to each client in turn, or a `BYPASSRLS` admin role — mirror FWB's `runWithBypassRls`.

- [ ] **Step 2: Apply to preview branch.** Run: `DATABASE_URL=<rls-test-url> npx prisma migrate deploy`. Expected: all policies created.

### Task E1c: Verify enforcement on the preview branch (TDD-style)

- [ ] **Step 1: Write `backend/__tests__/rls-enforcement.test.js`** — seed two clients; with `app.current_client_id` = client A via `runInTenantContext`, assert reads/writes for client B return 0 rows / are rejected; assert admin bypass still sees both.
- [ ] **Step 2: Run against preview branch → expect PASS.** Run: `DATABASE_URL=<rls-test-url> npx jest rls-enforcement --forceExit`. If any cross-tenant row leaks, fix the policy before touching prod.
- [ ] **Step 3: Add the same test to CI** (`pr-validation.yml` `validate-pr` already runs jest with a Postgres service — ensure migrations apply there so the test runs every PR).

### Task E1d: Switch the app connection to the non-owner role + cut over prod

- [ ] **Step 1: Update `backend/src/config/db.js`** so the Prisma connection runs as `force_app` (either via a `force_app` login user in `DATABASE_URL`, or `SET ROLE force_app` at connection start in the `$extends`/middleware). Add a boot-time assertion that `current_user` is NOT the owner in production.
- [ ] **Step 2: Verify locally against preview branch**, full app smoke (send a test campaign to a seeded client; confirm it works and cross-client reads fail).
- [ ] **Step 3: Back up prod first.** Run: `bash ~/.claude/scripts/backup-all-neon.sh` (or the WBS `scripts/backup-db.sh`). Confirm dump exists.
- [ ] **Step 4: Deploy migrations to prod via the normal path** (`prisma migrate deploy` runs in Railway `start.sh` pre-deploy). Watch the deploy + health check. Run the enforcement test against prod read-replica or a fresh prod snapshot.
- [ ] **Step 5: Delete the `rls-test` Neon branch** (free-tier cap). Run: `neonctl branches delete rls-test --project-id <WBS_PROJECT>`.
- [ ] **Step 6: Commit** the migrations + db.js + test together: `feat(rls): enforce postgres RLS on all tenant tables via force_app role`.

## WS-E2 (CRM): role-based authz guard + ADR (RLS is N/A)

### Task E2a: Architecture Decision Record

- [ ] **Step 1: Create `docs/adr/0001-crm-tenant-isolation.md`** stating: CRM is single-org; all authenticated staff share one workspace; isolation is by `Role` (`requireAdmin()`), not by tenant rows; Postgres RLS is intentionally not used because there is no second tenant to isolate from. The controls that make this safe: (a) every mutation behind `auth()` + `requireAdmin()` where destructive, (b) consistent `isDeleted: false` read filters, (c) no `Client` row is a login boundary.
- [ ] **Step 2: Commit** `docs(adr): crm tenant-isolation decision (role-based, RLS n/a)`.

### Task E2b: Authorization guard test (proves the control holds)

- [ ] **Step 1: Write `tests/integration/authz-guard.test.ts`** — assert: (a) unauthenticated request to a mutating API route → 401/redirect; (b) authenticated non-admin → 403 on an admin-only mutation; (c) every `findMany` in `src/app/api/**/route.ts` for `Client`/`Task`/`Meeting` includes `isDeleted: false` (static assertion via a small AST/grep check, or runtime: soft-deleted row not returned).
- [ ] **Step 2: Run → make it pass** (fix any route missing `requireAdmin()` or the soft-delete filter discovered here).
- [ ] **Step 3: Wire into CI** `integration` job; **commit** `test(authz): crm role-based isolation guard`.

---

# Workstream F — Security Headers / HTTPS everywhere

## WS-F0 (FWB): verify

- [ ] **Step 1:** Confirm `apps/web/next.config.js` + `apps/admin/next.config.js` `headers()` still emit HSTS + CSP + nosniff + Referrer-Policy + Permissions-Policy. Run a live check: `curl -sI https://wadyaljuz.com | grep -iE 'strict-transport|content-security|x-content-type'`. Expected: all present. No code change unless missing.

## WS-F1 (WBS frontend): add headers

**Files:** Modify `frontend/next.config.js`

- [ ] **Step 1: Extend the existing `async headers()`** to add a global security block alongside the existing `X-Robots-Tag`:

```js
async headers() {
  const securityHeaders = [
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
    { key: 'Content-Security-Policy', value: [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.onesignal.com https://*.sentry.io",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "img-src 'self' data: blob: https:",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' https://backend.forcemediakw.com https://*.sentry.io https://*.ingest.sentry.io wss:",
        "frame-ancestors 'self'",
      ].join('; ') },
  ];
  return [
    { source: '/:path*', headers: [
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet, noimageindex' },
      ...securityHeaders,
    ]},
  ];
},
```

- [ ] **Step 2: Verify on a preview deploy** then prod: `curl -sI https://ws.forcemediakw.com | grep -iE 'strict-transport|content-security'`. Tighten CSP if the app console shows blocked resources (loosen `connect-src`/`script-src` to the real origins only).
- [ ] **Step 3: Commit** `feat(security): add HSTS/CSP/security headers to WBS frontend`.

## WS-F2 (CRM): add headers

**Files:** Modify `next.config.ts`

- [ ] **Step 1: Add an `async headers()`** to the config object:

```ts
const nextConfig: NextConfig = {
  turbopack: {},
  outputFileTracingIncludes: { '/': ['./public/**/*'] },
  outputFileTracingExcludes: { '*': ['./knowledge/**/*', './knowledge'] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.onesignal.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self'",
              "connect-src 'self' https://*.onesignal.com https://api.groq.com",
              "frame-ancestors 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};
```

- [ ] **Step 2: Verify** on Vercel preview, watch the browser console for CSP violations (OneSignal SW, Groq calls), adjust origins. Then prod: `curl -sI https://crm.forcemediakw.com | grep -iE 'strict-transport|content-security'`.
- [ ] **Step 3: Commit** `feat(security): add security headers to CRM`.

---

# Workstream G — Merge Gates / Branch Protection

**Design:** Make tests + AI review + SAST **required status checks** on `main` for all three repos, require a PR (no direct push), and add a CODEOWNERS so a human is requested. The AI-review check being required is what enforces "can't merge until AI review passes (no critical)".

### Task G1: CODEOWNERS

- [ ] **Step 1: Create `.github/CODEOWNERS`** (per repo)

```
# Default owner for everything
*       @ForceAI-KW/maintainers
# Or, if no team: * ahmed0montaser
```

> If the `maintainers` team doesn't exist, use the personal handle. Branch protection "require review from Code Owners" then requests that reviewer.

- [ ] **Step 2: Commit** `chore: add CODEOWNERS`.

### Task G2: Apply branch protection via gh api (per repo)

- [ ] **Step 1: Determine the exact check names** to require. They are the **job `name:` values**:
  - FWB: `Lint`, `Typecheck`, `Build`, `Unit Tests`, `Integration Tests`, `E2E Tests`, `npm audit / security` (use the names as they appear in `ci.yml`), plus `Claude PR review`, `CodeQL analyze`, `Semgrep SAST`.
  - WBS: from `pr-validation.yml` — `validate-pr`, `migration-check`, `security-check`, `smoke-tests`, plus `Claude PR review`, `CodeQL analyze`, `Semgrep SAST`.
  - CRM: `Lint + Typecheck`, `Unit Tests`, `Integration Tests`, `E2E Tests (Playwright)`, `npm audit (zero vulns)`, plus `Claude PR review`, `CodeQL analyze`, `Semgrep SAST`.

  Verify the rendered check names after one PR run: `gh pr checks <pr> --repo ForceAI-KW/<SLUG>`.

- [ ] **Step 2: Apply protection** (example for FWB; adjust `contexts` array + slug per repo)

```bash
gh api -X PUT repos/ForceAI-KW/force-website-builder/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Claude PR review",
      "Semgrep SAST",
      "CodeQL analyze",
      "Lint", "Typecheck", "Build",
      "Unit Tests", "Integration Tests", "E2E Tests"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

> `enforce_admins: false` so Ahmad (sole owner) can still hotfix in an emergency; flip to `true` later if desired. `strict: true` requires the branch be up to date before merge.

- [ ] **Step 3: Verify** `gh api repos/ForceAI-KW/<SLUG>/branches/main/protection -q '.required_status_checks.contexts'`. Expected: the array prints. Re-run per repo.

### Task G3: Fix WBS PR audit severity (moderate → low)

**Files:** Modify `.github/workflows/pr-validation.yml`

- [ ] **Step 1: Change** the `security-check` job's `npm audit --audit-level=moderate` to match prod's zero-tolerance, and audit all three package dirs:

```yaml
- name: npm audit (prod zero-tolerance)
  run: |
    set -e
    npm audit --audit-level=low --omit=dev
    (cd backend && npm audit --audit-level=low --omit=dev)
    (cd frontend && npm audit --audit-level=low --omit=dev)
- name: Remove dead grep secret-scan
  run: echo "secret scanning handled by gitleaks.yml + trufflehog"
```

(Delete the old `grep -r "sk_live..."` no-op block.)

- [ ] **Step 2: Commit** `fix(ci): align WBS PR audit gate to low + drop dead grep scan`.

### Task G4: Fix CRM mis-indented `workflow_dispatch` (freebie)

**Files:** Modify `.github/workflows/ci.yml`

- [ ] **Step 1:** Move `workflow_dispatch:` (with `inputs.force_cloud`) out from under `concurrency:` to be a sibling key under `on:`. Verify with `actionlint` or `gh workflow view`.
- [ ] **Step 2: Commit** `fix(ci): correct workflow_dispatch indentation under on:`.

---

## Self-Review (run against the spec)

**Spec coverage check** — every item Ahmad listed maps to a task:

- OWASP ZAP → WS-C ✅ | Burp Suite → WS-C manual checklist ✅ | automated scanning → WS-B (SAST) + WS-C (DAST) ✅
- RLS on → WS-E (FWB verify, WBS full, CRM role-authz+ADR) ✅
- auth configured → already ✅ (verified in inventory; no task needed)
- HTTPS everywhere → WS-F ✅
- AI reviewer (architecture, SQLi, edge cases, N+1, flag auth/payments/deletions, ignore style, inline comments, critical blocks / warnings informational, can't merge until tests + AI pass, severity threshold) → WS-A prompt+script + WS-G required check ✅
- secret manager + auto-rotation (worth-it analysis: auto-safe set + manual reminders) → WS-D ✅
- "all status full, nothing partial/missing" → target matrix; CRM-RLS reclassified openly, not skipped ✅

**Placeholder scan:** no "TBD"/"add error handling"/"similar to" — all code blocks are concrete. The only deferred-by-design item is `CREDENTIAL_ENCRYPTION_KEY` rotation (intentionally a guided runbook, flagged with reason).

**Type/name consistency:** `runInTenantContext` used consistently (FWB `@ebda/database`, WBS `db.js`); check names in WS-G match job `name:` values gathered in inventory; `force_app` role name consistent FWB↔WBS.

**Known external prerequisites** (cannot be done from code alone — Ahmad/owner action): run `claude setup-token` once → set `CLAUDE_CODE_OAUTH_TOKEN` per repo (subscription, not API key); Infisical org + machine token; `NEON_API_KEY`; enable GitHub code scanning per repo if Advanced Setup prompts; confirm a Vercel preview URL exists for each app to point ZAP at (avoid scanning prod write paths).

---

## Execution notes

- Workstreams A, B, C, F, G are low-risk and can land in parallel across the three repos immediately.
- Workstream D (Infisical) is medium-risk — the zero-downtime cutover (D1 step 3) is the one to babysit; keep provider env vars until parity verified.
- Workstream E1 (WBS RLS) is the only high-risk piece — keep it on its own branch + preview Neon branch until E1c passes, then cut over prod with a backup in hand.
