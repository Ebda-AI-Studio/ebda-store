# Handoff — FWB OSOSS build program (develop-now, deploy-all-at-once)

_Updated 2026-07-22. Resume from here. Full context: memory [[project-fwb-ososs-competitive-strategy]]._

## Goal

Close the OSOSS competitive gaps in dependency order, one PR per feature. **Strategy (Ahmad, 2026-07-22):
keep DEVELOPING now; DEPLOY the whole stack at once later** — merges are blocked by a stuck CI runner,
so don't wait, just build. Governing thesis: **win on AI/AEO/agentic-commerce, don't rebuild OSOSS's
ERP breadth.**

## CI state (2026-07-23) — runner UNSTUCK; merges HELD per Ahmad (deploy-all-at-once)

- Runner works again. My 3 PRs (#881/#908/#920) had 2 fixable-mine issues — BOTH FIXED + pushed:
  - **#881 lockfile out-of-sync** (`npm ci` failed: magicast@^0.3.5). Cause: fresh-worktree bootstrap ran
    under local npm 11/node 25, producing a lockfile CI's npm 10.8.2 rejects. Fix: `npx npm@10 install
    --package-lock-only` → regenerated npm-10-compatible lockfile (commit 38e7f81d… includes this + gitleaks).
  - **gitleaks secret-scan** flagged CI-only test fixtures (perplexity/openai fake keys + the gsc-client
    RSA test key). Fix: `.gitleaks.toml` allowlist (literal values for the fake keys; PATH allowlist for the
    RSA PEM since gitleaks anchors private-key findings at the BEGIN line, so a value-substring can't match).
    **KEY INSIGHT: the self-hosted runner scans ONE shared clone containing ALL pushed branches**, so the
    allowlist had to go on ALL THREE branches (#881 38e7f81d, #908 5e6a5b86, #920 e982c731), not just 8A/8B.
- **REMAINING BLOCKERS (pre-existing, repo-wide, NOT mine — gate every merge):** Security Audit fails on all
  PRs incl the unrelated #874 (the 8 HIGH npm-audit findings — otel/next/sharp); E2E + Integration + RLS
  force_app Cutover Proof fail on #874 AND #908 (base/env breakage on main — the RLS cutover may be mid-flight).
  These need a real remediation/decision (Ahmad) before ANY merge; I will NOT admin-override security gates.
- **#879 was MERGED** (into feat/customer-groups) outside this session — #874's branch now carries customer
  groups + promotions. #874 is MERGEABLE/BEHIND.
- Merge order when unblocked: #874→main, then #881 + #908→main, then retarget #920→main.

## Current state

- **PR #874** (customer groups) + **PR #879** (promotions) — both OPEN, work-complete, still BLOCKED on
  the stuck self-hosted CI runner (verified 2026-07-22: #874 all 11 checks `pending`, `MERGEABLE`/`BEHIND`;
  #879 `UNSTABLE` only via inherited pending checks). When the runner unsticks: merge #874 → main, retarget
  #879 → main. Not code — infra.
- **NEW: Ahmad picked items 7, 8, AND 5 to build** (all three). Verified all three premises against source
  (the audit gap list was stale — item 4 was already built). Findings:
  - **Item 7 (agentic checkout)** — PARTIALLY BUILT. Read side (feed/JSON-LD/llms.txt) shipped; guest
    cart→order→payment REST already works headlessly. Gap = agent tool/MCP layer + no server-to-server
    payment. Scope M. **→ BUILDING NOW.**
  - **Item 8 (answer-engine/citation measurement)** — PARTIALLY BUILT. "Get citable" content mature; the
    MEASUREMENT half (did an engine cite us) doesn't exist. Scope L. **→ NEXT after 7.**
  - **Item 5 (ATP + stock transfers)** — PARTIALLY BUILT. Multi-warehouse counts + admin UI shipped, but no
    reserved qty, checkout never touches WarehouseStock (drifts after every sale), transfer_in/out are dead
    enum values. Also latent bug: setStock/adjustStock not tx-wrapped. Scope L (trimmable to M). Depth
    DEFERRED ("decide when we get there"). **→ LAST.**

## Item 7: Agentic Checkout (MCP) — ✅ COMPLETE → PR #881 (OPEN, do not merge)

- Worktree `_worktrees/force-website-builder__feat-agent-checkout`, branch `feat/agent-checkout`.
  All 7 SDD tasks done + per-task reviewed + whole-branch OPUS review (verdict: ready to merge).
  Pushed (HEAD ff7b6a33); **PR #881 → main, OPEN, NOT merged** (deploy-all-at-once batch).
- Shipped: `POST /api/v1/mcp/:storeSlug` stateless MCP (SDK 1.29.0 pinned), 7 tools (store/search/
  product/add_to_cart/view_cart/place_order/get_order_status); `agent_checkout` feature key (default-ON
  all paid plans); `Order.source` col + admin agent badge; llms.txt advertises the endpoint. COD
  autonomous; online returns paymentUrl (provider resolved before create → no orphan). Cross-tenant
  isolation tested (13/13 green). SDD ledger: `_worktrees/…feat-agent-checkout/.superpowers/sdd/progress.md`.
- **⚠️ DECISION PENDING (Ahmad) — online-payment go-live gate:** the online paymentUrl path is default-ON
  but UNEXERCISED in CI (no sandbox gateway). COD is fully tested. Before a merchant relies on agent
  ONLINE checkout: staging smoke vs a sandbox gateway, OR beta-flag online while COD leads. Not a merge
  blocker (order created unpaid, human-in-loop, rollback exists).
- Fast-follows (non-blocking, logged in PR #881): unify online-payment request-building into a shared
  `createPaymentForOrder`; COD retry/idempotency guard (agent-retry→double-order); anchor the /mcp CSRF
  skip. Pre-existing (separate tickets): CartItem Cascade-vs-RESTRICT schema/DB drift; 8 repo-wide HIGH
  npm-audit findings; agent_feed doc drift in 04-pricing-tiers/06-faq.

## Item 8 Plan 8A (answer-engine citation checking) — ✅ COMPLETE → PR #908 (OPEN, do not merge)

- Worktree `_worktrees/force-website-builder__feat-answer-engine-insights`, branch `feat/answer-engine-insights`.
  All 7 tasks done + per-task reviewed (2 Opus reviews caught+fixed a Critical budget-per-store bug + an
  MFA-bypass) + Opus whole-branch review (caught+fixed a Critical: admin config page missing /api/v1 prefix
  = built-but-unreachable; + cron per-store isolation). Pushed HEAD 70376f4f; **PR #908 → main, OPEN, NOT merged**.
- Shipped: pluggable AnswerEngineProvider (Gemini grounded ACTIVE/free + Perplexity/OpenAI DORMANT until
  keyed); weekly per-store citation-scan cron (platform-wide per-engine budget via withRlsBypass, fail-soft,
  plan+feature gated); super-admin encrypted-key/toggle config (MFA-gated); merchant dashboard (zero-dep
  charts, tenant-isolated). answer_engine_insights key (all paid plans); AnswerEngineCheck+ProviderConfig models.
  SDD ledger: `_worktrees/…answer-engine-insights/.superpowers/sdd/progress.md`.
- **⚠️ GO-LIVE GATE (Ahmad): live-smoke before selling as "real citation."** Gemini googleSearchRetrieval
  grounding on gemini-flash-lite-latest is likely IGNORED by 2.x models on SDK 0.24.1 → most stores get
  grounded:false. Before prod: smoke a grounding-capable model + set ANSWER_ENGINE_GEMINI_MODEL; smoke each
  paid engine (Perplexity Sonar / OpenAI web-search) before enabling. Same class as item-7 payment gate.
- Cost numbers Ahmad asked for (paid engines): ~$30-80/mo total @100 stores if BOTH enabled; free Gemini path = $0.
- Fast-follows (in PR #908): persist a real `grounded` column (dashboard uses citedUrls-emptiness heuristic
  now — honest); merchant-editable prompts (v1 auto-only); Store.country (v1 hardcodes Kuwait); coverage-
  rotation under the daily cap at scale (first ~25 stores exhaust 200/day); ai-tools rec deep-link anchor.

## Item 8 Plan 8B (Force-managed GSC ingestion) — ✅ COMPLETE → PR #920 (OPEN, STACKED on #908, do not merge)

- Worktree `_worktrees/force-website-builder__feat-answer-engine-gsc`, branch `feat/answer-engine-gsc`
  (stacked on feat/answer-engine-insights). All 4 tasks done + per-task reviewed + Opus whole-branch
  review (verdict: ready to merge, no Critical/Important). Pushed HEAD d15a2b58; **PR #920 → base
  feat/answer-engine-insights (STACKED), OPEN, NOT merged.** When 8A (#908) merges to main, RETARGET #920 → main.
- Shipped: GscDailyMetric model (RLS); gsc-client.ts (service-account via existing jsonwebtoken, NO new
  dep, dormant until GSC_SERVICE_ACCOUNT_JSON set, key never logged); daily fail-soft ingestion cron
  (idempotent upsert, tenant-scoped, plan+feature gated); dashboard GSC section (zero-dep charts,
  "not connected" empty state, tenant-isolated). Reuses answer_engine_insights key. SDD ledger in the worktree.
- **⚠️ GO-LIVE GATE (Ahmad):** dormant until (1) create Force Google service account, (2) add its
  client_email as a user on the Force-owned GSC properties, (3) set GSC_SERVICE_ACCOUNT_JSON in API env,
  (4) live-smoke one property. Documented in docs/runbooks/google-search-console-indexing.md + ENVIRONMENT.md.
- Fast-follows (in PR #920): all-zero-rows "still populating" hint; useGscDashboard error-vs-dormant state.

## Item 5 (WarehouseStock data-integrity) — IN PROGRESS (spec+plan committed, SDD running)
- Worktree `_worktrees/force-website-builder__feat-inventory-atp-reserved`, branch `feat/inventory-atp-reserved`
  off main. Depth = TRIMMED (Ahmad): just fix the 2 bugs, NO reserved/ATP (FWB already oversell-safe via
  decrement-at-order), NO transfer workflow. Spec 995bd540 + plan 058d20ab committed.
- KEY: Product.inventory stays authoritative + MONEY PATH UNTOUCHED; reconcile WarehouseStock TO the aggregate
  (default-warehouse-absorbs; sales reconcile async via order fanout, admin writes sync inline). 5 tasks:
  1) atomic setStock/adjustStock (race), 2) reconcileWarehouseStockToAggregate + backfill, 3) wire into admin
  writers, 4) wire into order fanout (money path untouched), 5) admin reconcile action + endpoint. Running via SDD.

## Left to do

- Finish item 5 SDD (5 tasks) → PR (do NOT merge; deploy-all-at-once). Then ALL THREE picks (7/8A/8B/5) done.

- **Item 5 (ATP + stock transfers)** — LAST of the three. Depth deferred ("decide when we get there"):
  full transfer workflow vs trimmed reserved-qty+ATP+fix-drift. Verify-first done (PARTIALLY BUILT, scope L).
  Crux: Product.inventory is authoritative + oversell-safe; WarehouseStock is an admin-side shadow that
  drifts (one-way sync only). Fix the WarehouseStock drift + the setStock/adjustStock race regardless of
  depth. New worktree off main → decide depth with Ahmad → spec → plan → SDD.
- **Item 5 (ATP + stock transfers)** — LAST. Depth deferred ("decide when we get there"): full transfer
  workflow vs trimmed reserved-qty+ATP+fix-drift. Verify-first done (PARTIALLY BUILT, scope L).
  Crux: Product.inventory is authoritative + oversell-safe; WarehouseStock is an admin-side shadow that
  drifts (one-way sync only). Fix the WarehouseStock drift + the setStock/adjustStock race regardless of
  depth. New worktree → decide depth with Ahmad → spec → plan → SDD.

**Fast-follow tickets (not blockers):**
- #879: createAdminOrder bypasses coupon scope/eligibility + auto-promos — apply evaluateForCart on admin path.
- #874: customer-groups/page.tsx save()/remove() never check `{ error }` (silent write-failure).
- Item 7: unify online-payment request-building into a shared `createPaymentForOrder` service (Task 6 dup).

## Notes
- Root checkout stays on `main`, read-only. Worktree per task.
- SDD adversarial review loop caught ~8 real money/security bugs last time — mandatory on revenue features.
- Blast-radius on every change; docs parity same session.
