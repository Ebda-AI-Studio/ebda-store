# Adversarial audit — slug: `falsification`

## Dimension: falsify the record (audits, gates, tests — not feature code)

Method note: every claim below was verified against the working tree at `4f202f22` (main, clean)
AND against live GitHub state (`gh run list`, `gh api` for variables/secrets/branch protection,
run logs). "Attack" = the scenario the dead gate / false claim lets through undetected.

> **Status note (2026-09-02, #1166):** this slice was written before, and merged after, PR #1133
> ("audit record and CI gates"), which fixed most of what's below — the zombie
> `preview-env-isolation.yml` gate is deleted, the orphaned tests are covered, gitleaks' blanket
> test-tree allowlist is removed, `E2E Tests` and `Client secret scan` are now required checks, and
> the falsified L16/L20 verdicts are corrected in place in `2026-08-31-reel-derived-lenses.md`. The
> findings below were left as originally written (not silently rewritten) — see the "Remediation
> status" table in `docs/audits/2026-09-02-adversarial-audit.md` for the authoritative per-finding
> fixed/open state.

---

### [P1] "Preview env isolation (rule 13)" is a zombie gate — green on every PR, verifies nothing, and the platform it checked no longer hosts FWB

- **Where:** `.github/workflows/preview-env-isolation.yml` (whole file)
- **Attack:** Point a PR preview / any preview-shaped worker at the production API (the exact
  data-integrity failure the gate was built for — test data written to live Neon). Nothing detects it:
  the gate that owns this risk exits 0 unconditionally.
- **Damage:** test/preview traffic mutating production data, undetected indefinitely; plus standing
  false assurance — the check shows `success` on every PR (verified: last 5 runs all `success`).
- **Evidence:**
  - The workflow queries **Vercel** projects (`api.vercel.com/v9/projects/…`), but FWB web/admin/orders
    moved to **Cloudflare Workers** in 2026-07 and the FWB Vercel projects are decommissioned
    (`docs/ENVIRONMENT.md:34`: "The Vercel account is CANCELLED … all deleted").
  - `VERCEL_API_TOKEN` is **absent from repo secrets** (verified via
    `gh api …/actions/secrets`: 16 secrets, none Vercel) → step hits
    `if [ -z "${VERCEL_API_TOKEN:-}" ]; then echo "::warning …" ; exit 0; fi`.
  - Even with a token, `vars.VERCEL_PROJECT_ID_WEB/ADMIN` are **absent from repo variables**
    (verified full list) → both project checks print a warning and `exit 0`.
  - No equivalent isolation check exists for the live Cloudflare path (`cf-deploy.yml` has none;
    grep for the CF workers' env parity came up empty).
- **Why prior audits missed it:** `2026-07-02-observability-dr-cicd.md`-era audits predate the CF
  migration; nothing re-audited the workflow after the platform it monitors was retired. Exactly
  Ahmad's rule: _a gate's NAME is not proof it runs_ — here the gate runs and still proves nothing.
- **Blast radius:** same class candidates checked: `runner-health-check.yml` (also dead, but
  HONESTLY dead — header documents the disabled schedule and hands ownership to the Mac-side
  `ci-runner-guard.sh`; not a lie), `neon-snapshot.yml` (`disabled_manually`, matches the
  "per-commit Neon snapshots RETIRED" memory — consistent).
- **Fix:** delete the workflow or rewrite it against the real surface (compare
  `NEXT_PUBLIC_API_URL` bound into the CF preview builds vs production; the value already lives in
  repo variables). A gate that cannot fail must not report success.

---

### [P1] Four colocated web tests run NOWHERE — the exact orphan-test class CI's own comment warns about, recurred after the fix

- **Where:**
  - `apps/web/src/app/checkout/_lib/deliveryWindows.test.ts` (checkout logic)
  - `apps/web/company-host-route.test.ts` (tenant/company host routing — security-adjacent)
  - `apps/web/src/app/llms.txt/route.test.ts`
  - `apps/web/src/app/products/[slug]/ProductDetailBody.test.tsx`
- **Attack:** regress checkout delivery-window logic or company-host routing; the regression test
  that would catch it exists, passes locally when someone happens to run the full suite, and never
  executes in CI or pre-push — the PR merges green.
- **Damage:** silent regression in checkout/tenant-host code with a false "it's tested" record.
- **Evidence:** CI unit job runs
  `npx vitest run tests/unit packages/shared/src packages/database/src apps/web/src/lib apps/admin/src`
  (`ci.yml`, Unit Tests step); integration job runs `tests/integration apps/api/src`; e2e job runs
  `tests/e2e`; pre-push runs `tests/unit` only. I ran
  `npx vitest list tests/unit packages/shared/src packages/database/src apps/web/src/lib apps/admin/src`
  → 167 files; the only `apps/web` entries are under `src/lib/`. The four files above match none of
  the seven globs. The Unit job's own comment says it: "Adding a colocated test outside these paths
  = a test that does not run." That comment is now the bug's epitaph, not its fix.
- **Why prior audits missed it:** the orphan-suite fix (documented in the same CI comment, "18 files
  / 200 tests that had never run") enumerated directories once and froze them; new tests were added
  outside the list afterwards. No gate compares `vitest list` (full config) against the union of CI
  globs.
- **Blast radius:** any future colocated test in `apps/web/src/app/**`, `apps/orders/**` (which has
  ZERO tests today), or a new `packages/*` — the class is unbounded until enumerated centrally.
- **Fix:** add a CI step that diffs `vitest list` (root config, minus tests/smoke) against the union
  of files the unit+integration+e2e jobs execute, and fails on any orphan. One-time: add
  `apps/web/src/app` + `apps/web` root to the unit glob (all four orphans are pure/no-DB).

---

### [P1] The five-layer testing claim is 60% real: load layer dead 3 months, perf layer red 7 weeks with no alert, UAT nonexistent

- **Where:** `.github/workflows/load-test-nightly.yml`, `.github/workflows/lighthouse-nightly.yml`,
  `loadtests/results/` (empty dir)
- **Attack:** ship a p95 cliff (an N+1 on the storefront hot path, a cache regression). Nothing
  measures latency anywhere: k6 never runs, Lighthouse fails at healthcheck nightly, no SLO/burn-rate
  alerting exists. First detector is a churning merchant.
- **Damage:** performance regressions live in prod indefinitely; the "5 testing layers" record
  (code-quality rule 14) reads as satisfied while layers 4 (load) and 5 (UAT) are fiction and the
  nightly perf audit is a corpse.
- **Evidence:**
  - `load-test-nightly.yml`: schedule commented out ("DISABLED 2026-05-27"); last runs are three
    `workflow_dispatch` **failures on 2026-06-04**; `loadtests/results/` is empty — no k6 run has
    ever produced an artifact. The k6 secrets (K6_BASE_URL etc.) still exist, pointing at a
    "staging Railway env" that was retired 2026-06-13 per ci.yml's own comment.
  - `lighthouse-nightly.yml`: runs every night, **every run since 2026-07-13 is failure/cancelled**
    (verified via `gh run list`, last success 2026-07-13). Cause from the 2026-09-02 log:
    `❌ Chrome installation not found` on the umbra runner — pure infra, trivially fixable, unfixed
    for 7 weeks because the workflow has **no notify-failure job** (ci.yml/gitleaks.yml have one;
    this one doesn't).
  - UAT: no artifact, doc, or checklist anywhere (`grep -ril uat docs/` matches only "eval**uat**e").
- **Why prior audits missed it:** `2026-08-31-reel-derived-lenses.md` L20 records **PASS** for
  "No SLO / error budget / burn-rate alerting" with evidence "Sentry wired, alert-failure watch,
  log drain" — a category error: error tracking is not latency SLO/burn-rate alerting, and the two
  workflows that did watch performance are dead. That PASS is FALSIFIED (see below).
- **Blast radius:** `ai-eval-nightly`, `db-backup`, `auto-fix-watchdog`, `zap-baseline` share the
  nightly-cron shape; checked — all succeeded within the last 24h (zap flapped
  failure/cancelled/success across 3 days; it files report issues, e.g. #1126, so it is alive).
  The defect class ("scheduled job red forever, nobody paged") currently has exactly one live
  member: lighthouse.
- **Fix:** add the standard Telegram notify-failure job to lighthouse-nightly (and any scheduled
  workflow without one); install Chrome on the umbra guest or run LHCI against the deployed URL from
  the Mac guard; either resurrect one k6 scenario on a cadence tied to infra changes or delete the
  "load" layer from the record so the record matches reality.

---

### [P2] gitleaks is blind to the entire test tree, and the secret-scanner's own config is classified as a "docs-only" change

- **Where:** `.gitleaks.toml:40-46` (paths allowlist), `.github/workflows/ci.yml:9-15`
  (push `paths-ignore` includes `.gitleaksignore` + `.gitleaks.toml`) and the `changes` job filter
  (same list ≙ "code=false")
- **Attack:** (a) a real credential pasted into any `*.test.ts` or `__tests__/**` file — the most
  common real-world leak shape, a dev testing against a live API — is permanently invisible to the
  required "Scan for leaked secrets" check. (b) A compromised/hasty PR weakens `.gitleaks.toml`
  (one more allowlist regex) in a change the CI `changes` filter treats as docs-only — Build, Unit,
  Integration, E2E, RLS proof all skip — and the gitleaks job on that same PR runs WITH the
  weakened config. Only human/AI review stands between that and main.
- **Damage:** leaked provider keys (Tap/MyFatoorah/Gemini/Meta) reaching a public-ish repo history
  with the "secrets gate: green" record intact.
- **Evidence:** `.gitleaks.toml` allowlist paths:
  `'''.*\.test\.(ts|tsx|js)$'''` and `'''.*/__tests__/.*'''` — comment admits it "consolidates so
  gitleaks stops re-flagging fixtures one at a time." trufflehog partially compensates but runs with
  `--only-verified` (`ci.yml` Check for secrets step) — an unverifiable or revoked-but-sensitive
  secret in a test file is caught by neither.
- **Why prior audits missed it:** the handoff (2026-07-23) records the allowlist being ADDED as a fix
  for fixture false-positives; nobody scored the fail-open cost. Ahmad's own memory has the exact
  lesson ("a declared-but-uninstalled gate fails OPEN, silently") — this is its allowlist cousin.
- **Blast radius:** `.gitleaksignore` (commit-pinned entries, self-expiring — lower risk);
  `.bundle-scan-allow` for `scan-bundle-secrets.sh` (checked: file absent, so no allowlist active
  there — clean).
- **Fix:** replace the two blanket path regexes with the literal-value allowlist entries the file
  already uses (it has 12 — the mechanism works); remove `.gitleaks.toml`/`.gitleaksignore` from the
  docs-only filter so config changes to a security gate count as code.

---

### [P2] The two AI gates fail OPEN on every infra error, are not required checks, and the blocking one runs the author's model

- **Where:** `.github/workflows/scoped-audit.yml:46` (`continue-on-error: true` on the model step),
  `.github/scoped-audit/audit.mjs:8,27-71` ("any infra/parse/network error → exit 0 (FAIL-OPEN)"),
  `.github/workflows/ai-review.yml:89-93` (token unset → fabricate empty-findings JSON, exit 0)
- **Attack:** OAuth token expires / model id is deprecated / the CLI update breaks JSON output →
  both AI gates go permanently green while reviewing nothing. Nobody notices because green is the
  normal state. A P0-carrying PR then merges with only deterministic gates looking at it — which is
  precisely the configuration the gates were added to compensate (solo dev, no human reviewer).
- **Damage:** the review layer the repo's own audit (GAP-2, 2026-08-31) calls load-bearing can
  silently not exist for weeks.
- **Evidence:** quoted above; plus live confirmation the failure mode is real: issue **#1115**
  "Unvalidated --model change in a continue-on-error step fails the gate open" (filed by the
  audit-followup mill, still open). Branch protection requires
  `Lint, Type Check, Build, Unit Tests, Integration Tests, Security Audit, Semgrep SAST, Scan for
leaked secrets, RLS force_app Cutover Proof` — **neither AI gate, nor E2E Tests, nor Client
  secret scan, is required** (verified `gh api branches/main/protection`). Issue **#1116** records
  the rotation half-fix: the review runs Fable 5, but the BLOCKING scoped-audit still runs
  `claude-opus-5` — the author's model.
- **Why prior audits missed it:** GAP-2's remediation (#1113) rotated the advisory reviewer and
  declared the lens addressed; the fail-open plumbing and the required-checks gap were out of its
  frame.
- **Blast radius:** same fail-open shape in `blast-radius.yml` (`continue-on-error` on both steps —
  acceptable, it is explicitly informational). E2E-not-required means a red E2E job cannot stop a
  merge — it has been green, but the protection list should say what the record claims it says.
- **Fix:** in scoped-audit, distinguish "model ran, found nothing" from "model never ran": write a
  sentinel on successful model completion and have `audit.mjs` exit 1 (or at least alert) when it's
  absent N times in a row; add `E2E Tests` + `Client secret scan` to required checks; move the
  blocking gate to the non-author model per #1116.

---

### [P2 — FALSIFIED verdict] 2026-08-31 lens L16 "PASS — 324 storeId columns, 233 RLS policy statements": RLS is still INERT in production

- **Where:** `docs/audits/2026-08-31-reel-derived-lenses.md` (L16 row); contrast
  `docs/audits/2026-07-31-vibecoded-security-holes.md` lens 02
- **Attack:** not directly exploitable (app-layer authz was independently verified per-route), but
  every future reader of the newest audit — including the next agent deciding whether an IDOR is
  "backstopped by RLS" — is being told the DB enforces tenant isolation. It does not, for any row,
  for any live connection.
- **Damage:** risk decisions made on a false premise; the exact regression the 07-31 audit warned
  against in writing: "Counting policies tells you what was provisioned; only the role's
  `rolbypassrls` tells you whether any of it applies." The 08-31 audit regressed to policy-counting.
- **Evidence:**
  - `docs/ENVIRONMENT.md:15` (still current, file last touched 2026-08-09): prod `DATABASE_URL`
    "currently connects as `neondb_owner`, a BYPASSRLS role"; boot guard escaped via
    `ALLOW_BYPASSRLS_ROLE=true` (`apps/api/src/index.ts:521-561`).
  - The flip is PARKED by explicit decision (memory
    `project-fwb-rls-cutover-and-security-program-2026-07`: "we will merge when I tell you"), and its
    prerequisite Phase-1 plumbing is verifiably NOT shipped:
    `git cat-file -e origin/main:packages/database/src/tenant-storage.ts` → **does not exist** (the
    plan's own absence-test for "plumbing not on main").
  - Corollary: the required CI check named **"RLS force_app Cutover Proof"** proves migrations work
    under `force_app` in an ephemeral container — a state production has never run. The check is
    real and valuable, but its green + its name together imply an enforcement that does not exist
    in prod. Gate NAME ≠ world.
- **Why prior audits missed it:** the 07-31 audit got this exactly right; the 08-31 one was a
  21-lens sweep and spent one grep on L16.
- **Blast radius:** any doc/audit line reading "backstopped post-cutover" is a promise, not a state;
  L9's PASS ("npm ci + npm audit gate, trufflehog + gitleaks in CI" vs _malicious dependency
  exfiltrating env_) and L20's PASS (Sentry vs _SLO/burn-rate_) are the same shape — evidence that
  doesn't establish the lens's claim.
- **Fix:** re-mark L16 "PASS-provisioned / INERT-in-prod (cutover parked)" in the audit file; add a
  standing rule to the lens pack: an RLS verdict must cite the `pg_roles.rolbypassrls` query result,
  never a policy count.

---

### [P2 — FALSIFIED verdict] "Checkout inventory decrement is oversell-safe" (2026-07-15 money audit) — production reached inventory = −16 six weeks later

- **Where:** `docs/audits/2026-07-15-money-integrity-audit.md` ("What's already solid":
  "oversell-safe — atomic conditional UPDATE … WHERE inventory >= qty"); disproven by
  `docs/audits/2026-08-30-variant-stock-drift.md`
- **Attack:** n/a (already happened): variant sales decremented the PARENT product via an unfloored
  helper outside the guarded path; 24 products went negative (worst: parent −16 while variants held
  1,173), poisoning cart validation, dashboards, low-stock scans, WhatsApp catalog, payment links.
- **Damage:** `INSUFFICIENT_INVENTORY` on 92 in-stock products for a live merchant (lost sales), and
  a PASS verdict that stood in the record for 6 weeks while prod drifted.
- **Evidence:** both audit files as cited; root cause table in the 08-30 audit; memory
  `feedback-one-column-two-meanings-drifts` records 11 readers / 8 wrong.
- **Why prior audits missed it:** the 07-15 audit verified ONE writer (`order.service.ts:436-494`)
  and asserted a SYSTEM property ("oversell-safe"). The sibling writer used a different helper.
  This is the report-level version of "a reported bug is a sample of a defect class."
- **Blast radius:** every "already solid" bullet in that audit is a one-path verification promoted
  to a system claim; treat each as scoped to its cited lines.
- **Fix:** lens-pack rule: a PASS on an invariant must enumerate ALL writers of the guarded column
  (the 08-30 fix did this; the verdict discipline should too).

---

### [P2] Mutation testing exists as a config and a 3-month-old 9.34% baseline; auth.service.ts scored 0% — the mocks are so complete the unit tests cannot fail against real code

- **Where:** `stryker.conf.json` (thresholds `"break": null`), commit `87251543` (2026-05-24),
  `docs/test-reports/stryker-baseline-2026-05-24/`
- **Attack:** break `auth.service.ts` (the login/lockout/token logic) in a way its unit tests mock
  around — the suite stays green. The baseline PROVES this: 1054 mutants, 867 no-coverage, and
  **0% of auth.service mutants killed** ("unit tests mock the service layer and never import the
  real modules" — the commit's own words). Same for `ai-quota.ts` (0%).
- **Damage:** the unit layer's green is weak evidence for exactly the files where it matters most;
  no gate ratchets it (break: null, not wired into any workflow — verified zero references in
  `.github/workflows/`).
- **Why prior audits missed it:** the baseline commit itself is the audit — it was filed and never
  acted on; no follow-up run in 3+ months, no issue tracks it.
- **Blast radius:** `payment.service.ts` and `recommendation.service.ts` are in the same mutate list;
  integration tests partially compensate for payment (real HTTP server + DB in CI), not for auth
  internals.
- **Fix:** re-run stryker quarterly on the 4 configured files; set `break` to the current score per
  file so it can only ratchet up; or explicitly retire the config so the record stops claiming
  mutation testing exists.

---

### [P3] Playwright smoke suite: five browsers × real prod URLs, wired to nothing, defaults pointing at a legacy domain

- **Where:** `playwright.config.ts`, `tests/smoke/*.smoke.spec.ts`
- **Attack:** the post-deploy "does prod actually render" layer never runs: zero references to
  playwright/smoke in any workflow (verified grep over `.github/workflows/`), not in pre-push, and
  `cf-deploy.yml` has no post-deploy verification at all (railway-deploy at least curls `/health`).
  Default `ADMIN_BASE_URL = https://app.forcemediakw.com` now 301s to `admin.force-ai.co`
  (verified live curl).
- **Damage:** a broken deploy of web/admin/orders workers is detected by users, not by the repo.
- **Fix:** run the chromium storefront+admin smoke projects as a post-deploy job in `cf-deploy.yml`;
  update the default URLs.

---

### [P3] FIXES.md is a 4-month-old fossil presenting fixed (and re-decided) findings as open P0s

- **Where:** `FIXES.md` (dated 2026-04-30, "This commit will land…")
- **Attack:** any agent or human obeying "read FIXES.md" plans work against a world where trust-proxy
  is unset, shipping is hardcoded 0, `OrderItem.variantId` is dropped, and 38 criticals are open —
  all long since fixed (verified samples: T0-2's FAQ/order routes now carry
  `requireStoreAccess` + storeId-scoped lookups, `product.routes.ts:830-870`; refund reversals moved
  to the Inngest fanout per #758). Meanwhile it UNDERSTATES the one thing still true (T0-1: RLS
  bypass — still the prod state, but the file's fix instruction is now wrong: flipping today without
  the unmerged plumbing = write outage per the cutover plan).
- **Fix:** replace the body with a 5-line pointer: "historical (2026-04-30); current state lives in
  docs/audits/ + the cutover plan; T0-1 remains open and PARKED — see
  docs/plans/2026-07-02-rls-cutover.md."
- **Blast radius (same class):** `handoff.md` — updated 2026-07-22, describes PRs #874/#881/#908/#920
  as open-and-held with a stuck runner; main is at #1111 with a healthy runner. CLAUDE.md's
  session-handoff rule promises the NEXT session auto-resumes from this file — it would resume into
  a 6-week-old world. Pre-push hook comment claims blast-radius/scoped-audit/ai-review "moved OUT of
  CI to this pre-push gate" while all three workflows still run on every PR (they now run TWICE:
  once locally advisory, once in CI).

---

## FALSIFIED (prior-audit PASS verdicts disproved)

1. **`2026-08-31-reel-derived-lenses.md` L16** ("Per-client column degrades every tenant — PASS: 324
   storeId columns, 233 RLS policy statements"): the implied enforcement doesn't exist in prod —
   BYPASSRLS role, flip parked, plumbing absent from main (`tenant-storage.ts` fails
   `git cat-file -e` against origin/main). Provisioned ≠ applied; the repo's own 07-31 audit states
   the exact rule this row violates.
2. **`2026-08-31-reel-derived-lenses.md` L20** ("No SLO/error budget/burn-rate alerting — PASS:
   Sentry wired, alert-failure watch, log drain"): no SLO, no error budget, no burn-rate alerting
   exists anywhere; both performance-watching workflows are dead (k6 since May, Lighthouse red since
   2026-07-13). The cited evidence is error tracking, which is not what the lens asks.
3. **`2026-07-15-money-integrity-audit.md`** "already solid: checkout inventory decrement is
   oversell-safe": production reached −16 via the unguarded parent-decrement writer
   (`2026-08-30-variant-stock-drift.md`). One-path verification promoted to a system claim.
4. **The five-layer testing record** (rule 14 / testing-stack-plan): layers 1-3 run in CI; layer 4
   (load) has never produced a green run or a single results artifact; layer 5 (UAT) has no artifact
   at all.

## UPHELD (attacked hard, could not break)

1. **The 33dc6003-class fix (db-guard).** `tests/helpers/db-guard.ts` +
   `tests/setup-e2e.ts` genuinely close both original defects: suite detection via
   `expect.getState().testPath` inside `beforeAll` (fork-safe — I checked the setup-file load order
   and the CI env values end-to-end: CI's test DB URL (scheme `postgresql`, `test:test@localhost:<dynport>/force_test`,
   same fixture `.secretlintignore` already allowlists for `ci.yml`) passes the allowlist; an unknown host throws), the check is an ALLOWLIST, the module is pure and
   itself unit-tested (`tests/unit/db-guard.test.ts` runs in CI's glob — confirmed in the
   `vitest list` output). I hunted the same class: the `hasDb` module-load guards in
   `rls-async-context.test.ts` / `order-created-idempotency.test.ts` resolve correctly in CI
   (dynamic port ≠ the `localhost:5432/test_db` placeholder) and skip correctly locally.
   Residual observation only: colocated `apps/api/src/**/__tests__` DB-touching tests are outside
   `isIntegrationTestPath`'s pattern, so the prod-DB guard doesn't cover them — low risk (vitest
   doesn't export `.env` into `process.env`, so locally they hit the placeholder), but the pattern
   should include them for symmetry.
2. **The npm-audit gate.** `.github/scripts/audit-gate.mjs` is the opposite of theatre: allowlist
   EMPTY as of 2026-08-08, dead waivers actively removed with reasoning, JSON parsed for real,
   non-zero exit on any unwaived advisory, runs in a required check. Tried to find a
   grep-matches-the-negative or fail-open path; there isn't one (missing output → exit 1).
3. **The deterministic CI core.** All 9 required checks are real jobs that ran and passed on the
   latest main run (verified per-job conclusions); gitleaks/semgrep/trufflehog are installed at
   pinned versions and their steps fail closed (no `continue-on-error`, no `|| true` on the scan
   commands); the audit-followup issue mill (#1110-#1126) shows audit gaps becoming tracked issues
   rather than fossils — GAP-3 (deprecation policy) was closed by #1113 within a day, GAP-1 (SSRF)
   got an ESLint selector whose own bypass shapes are already tracked (#1112/#1120/#1122).
4. **Test-quality basics.** No `.only` anywhere; the three `it.skip`s in `tests/e2e/checkout.test.ts`
   are honest (routes that don't exist); no assertion-free unit tests found; no `expect` swallowed
   by empty catches in `tests/`.

## BLIND SPOTS (what I could not verify statically, and what settles it)

1. **Prod `rolbypassrls` right now.** Everything says the flip hasn't happened; the settling fact is
   one read-only query on the prod branch:
   `SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname IN ('neondb_owner','force_app');`
   (via neonctl, project `crimson-king-40424588`). Also `railway variables` for
   `ALLOW_BYPASSRLS_ROLE`.
2. **Whether the smoke suite even passes today.** `SMOKE_ADMIN_URL=https://admin.force-ai.co npx playwright test --project=storefront --project=admin` — 2 minutes, settles it.
3. **Semgrep analyzer staleness.** The shared `/opt/semgrep-venv` on the umbra guest refreshes only
   out-of-band; the workflow merely prints a `::notice` when >30 days old. Settle:
   `ls -la /opt/semgrep-venv` on the guest, or read the notice in the latest Semgrep run log.
4. **Whether Integration's `describe.skipIf` suites actually executed in the last run** (vs silently
   skipped). Settle: `gh run view <run> --log` grep for "RLS async-context guard" and the reported
   test counts.

## The uninstrumented dark (nothing watching), ranked by time-to-notice

1. **Latency/perf of everything** — no load tests, no Lighthouse (dead), no SLO/burn-rate, Sentry
   only sees errors. A 3× p95 regression is invisible until a human complains. Longest-unnoticed.
2. **The orders PWA (`apps/orders`)** — zero test files in the entire app (verified), no smoke
   project, no Lighthouse target; it has Sentry + PostHog, so hard breakage eventually surfaces, but
   any logic/UX regression (order lookup, push flows) ships blind.
3. **Preview/test-env writes to prod data** — the gate owning this is the zombie of finding #1;
   nothing watches the CF-era equivalent.
4. **Test-file secret leakage** — carved out of gitleaks by the blanket allowlist; trufflehog
   `--only-verified` catches only live-verifiable creds.
5. **Colocated-web-test execution** — the 4 orphans, and every future one, until a list-vs-run diff
   gate exists.
6. **Live payment-gateway behavior** (per `2026-07-17-untested-flows-payment-mobile-audit.md`, still
   true: no sandbox exercise in CI; MCP agent ONLINE payment path explicitly flagged "UNEXERCISED"
   in handoff and never smoke-tested since).
