# P2 Audit-Backlog Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan batch-by-batch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 446 open `audit-followup` P2 findings without ever breaking order placement or payment.

**Architecture:** Batches of 4-8 findings that share ONE file or ONE mechanism, ordered by measured production exposure — not by issue count. Each batch is one PR: verify every claim against current code first, fix only what reproduces, mutation-prove each fix, and run a money-path control against `origin/main` before pushing. A finding that does not reproduce is closed with the evidence, not fixed.

**Tech Stack:** Express + TypeScript (`apps/api`), Next 16 (`apps/web`, `apps/admin`, `apps/orders`), Prisma 6 / Neon Postgres, Redis, vitest.

**Spec:** none — this plan argues from the issue tracker. Each batch's authority is the issue bodies it names, and the production measurements in "Exposure ranking" below.

---

## Global Constraints

**THE HARD RULE — no order or payment path may break.** Every batch that touches the money path proves it, in this order, before the PR opens:

1. `npx vitest run $(cat /tmp/p2-control-files.txt)` — every FILE frozen in the Step 4
   control must still pass (#1779). A new test a batch adds under the same
   `order|cart|payment|inventory|bundle` grep (Batches 3, 5, 6 all create one) legitimately
   grows the file/test count — that is not a regression. Only a pass→fail transition in a
   frozen control file is.
2. A live production read after merge: `orders`/`payments` counts unchanged-or-increased, **zero** rows in `payments` with `status IN ('failed','cancelled')` created after the deploy.
3. A guest cart round-trip against production (`POST /stores/:id/cart/items` → 201).

If any control file in (1) fails, the PR does not open.

- **Money path files** (the rule's scope): `apps/api/src/services/order.service.ts`, `routes/order.routes.ts`, `services/cart.service.ts`, `routes/cart.routes.ts`, `services/payment-providers/**`, `routes/payment.routes.ts`, `services/inventory.service.ts`, `lib/effective-inventory.ts`, `apps/web/src/app/checkout/**`, `apps/api/src/mcp/tools/{cart,order}.tools.ts`, `lib/inngest/functions/order-*.ts`.
- **Integration tests must be RETRY-SAFE** (CLAUDE.md's RETRY-SAFE section): take cart sessions from `cartSessionId()` (`tests/helpers/bundle-fixtures.ts`), and give every other per-test fixture a per-CALL unique id, never one derived from a per-file suffix. Batch 3 is exactly a cart-focused integration-test batch, so this applies to it directly — a fixture keyed on a per-file id is reused across the integration job's `--retry=1` attempts and turns a real attempt-1 failure into a misleading attempt-2 artefact.
- **Never widen a money-path query.** Narrowing filters (`deletedAt: null`, `storeId`) are safe and already proven. Widening one, or changing an amount/rounding/currency expression, requires its own PR with nothing else in it.
- **Audit findings are claims, not facts.** Verify each against current code before fixing. Roughly 1 in 4 does not reproduce.
- **Mutation-prove every fix**: break it, name the reddening test, restore byte-identical.
- **New integration tests must be RETRY-SAFE (#1780).** `vitest.config.ts` sets `retry: 1`, and a retry re-runs the test body against the SAME database — a fixture keyed on a per-FILE id (a `sessionId`, slug or email built from one `suffix`) is reused across attempts, so it either accumulates the failed attempt's rows or trips a unique index, and the reported error is an artefact of attempt 2 while the real attempt-1 failure is invisible (this is how a cart 500 was mis-read as a pricing bug for a day). Any new integration test — Batch 3's `cart-nested-transaction.test.ts` included — takes its cart session from `cartSessionId()` (`tests/helpers/bundle-fixtures.ts`) and gives every other per-test fixture a per-CALL unique id. See CLAUDE.md's "Integration tests must be RETRY-SAFE" section for the full rule.
- **Register security fixes** in `docs/security/defence-mutations.json`, and add the source file to `.github/workflows/mutation-testing.yml` `paths` or the gate never runs on it.
- **A worktree needs its own `npm ci`** + `prisma generate` + `npm run build -w packages/{shared,database}`. A symlinked `node_modules` breaks `@ebda/*` resolution and fabricates failures — it produced 115 phantom ones on 2026-09-11.
- **Integration tests:** set `TEST_DATABASE_URL` (not `DATABASE_URL` — `db-guard` refuses production Neon) to a **localhost-published** port, or every suite silently SKIPS. Read the zero-skipped number, never the passing tail.
- **commitlint:** subject must be entirely lower-case (a route name or camelCase identifier counts); scope from `api, web, admin, database, ui, shared, config, auth, store, product, order, cart, deps, ci`.
- **Never `git add -A`.** Stage explicit paths.
- **One `closes` keyword per issue.** `Closes #a, #b` closes only `#a`; the rest
  stay open and are indistinguishable from unfinished work.

## Exposure ranking (measured 2026-09-12, production)

| Signal                                   | Value  | Consequence                                 |
| ---------------------------------------- | ------ | ------------------------------------------- |
| orders                                   | 143    | order path is LIVE                          |
| payments completed                       | 77     | payment capture is LIVE                     |
| carts                                    | 10,264 | cart path is LIVE, highest volume           |
| **refunds ever** (`refunded_amount > 0`) | **0**  | every gateway-refund finding is unexercised |
| **returns ever**                         | **0**  | `return.service.ts` has never run           |
| **loyalty transactions**                 | **0**  | `loyalty.service.ts` has never run          |

446 findings split: **368 live · 24 never-executed · 54 CI-only.**

This ranking is the plan's spine. `return.service.ts` is the single biggest file cluster (16) and is sequenced near the END, because not one of those lines has ever executed.

---

## Batch order

Each batch is one PR. Batches 1-6 are live code; 7-9 are lower exposure; 10-11 are never-executed code.

| #   | Batch                                                                            | Findings | Exposure               |
| --- | -------------------------------------------------------------------------------- | -------- | ---------------------- |
| 1   | `auth.service.ts` refresh-token race                                             | 6        | every login            |
| 2   | `security.ts` origin gates                                                       | 4        | every request          |
| 3   | `cart.service.ts` nested transactions                                            | 6        | 10,264 carts           |
| 4   | `apps/web/src/lib/api.ts` CSRF self-heal                                         | 5        | every storefront write |
| 5   | `CheckoutClient.tsx` + checkout surfaces                                         | 11       | every checkout         |
| 6   | `order.service.ts` + `order.routes.ts` live half                                 | ~9       | 143 orders             |
| 7   | `sitemap.ts` + storefront SEO                                                    | 12       | public, no money       |
| 8   | `admin.routes.ts` + admin surfaces                                               | 30       | staff only             |
| 9   | CI / tooling config                                                              | 54       | zero production risk   |
| 10  | refund path (`payment.factory`, `order.routes` refund half, `refund-settlement`) | ~30      | **never executed**     |
| 11  | `return.service.ts` + `loyalty.service.ts` + partial-return posting              | 28       | **never executed**     |
| 12  | remainder — long tail across ~150 files                                          | ~250     | mixed                  |

---

## Per-batch procedure

Every batch follows the same seven steps. They are written once here rather than repeated twelve times; a batch's own section lists only what is specific to it.

- [ ] **Step 1: Create the worktree and install**

```bash
~/.claude/scripts/new-task-worktree.sh ebda-store fix/p2-batch-<N>-<slug>
cd ~/Desktop/projects/_worktrees/ebda-store__fix-p2-batch-<N>-<slug>
npm ci --no-audit --no-fund
npx prisma generate --schema packages/database/prisma/schema.prisma
npm run build -w packages/shared && npm run build -w packages/database
```

- [ ] **Step 2: Read every finding in the batch and VERIFY it against current code**

For each issue, open the `**Location:**` and check the claim reproduces. Record one line per finding: `#N — REPRODUCES` or `#N — DOES NOT REPRODUCE: <evidence>`. Expect roughly a quarter not to.

- [ ] **Step 3: Start the test database**

```bash
container run -d --name ebda-p2-pg -p 55432:5432 \
  -e POSTGRES_PASSWORD=testpw -e POSTGRES_USER=test -e POSTGRES_DB=ebda_test \
  -e PGDATA=/var/lib/postgresql/data/pgdata docker.io/library/postgres:17
export PG_TEST_PW=testpw
export TEST_DATABASE_URL="postgresql://test:${PG_TEST_PW}@127.0.0.1:55432/ebda_test"
export DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" JWT_SECRET=t
npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
```

- [ ] **Step 4: Record the money-path control on `origin/main` BEFORE changing anything**

```bash
cd ~/Desktop/projects/ebda-store   # main checkout, on main
npm run build -w packages/shared && npm run build -w packages/database
ls tests/integration/*.test.ts | grep -iE "order|cart|payment|inventory|bundle" \
  | tee /tmp/p2-control-files.txt
npx vitest run $(cat /tmp/p2-control-files.txt) \
  2>&1 | tee /tmp/p2-control.txt | grep -E "Test Files|^ *Tests "
```

Expected today: `Test Files 13 passed (13)` / `Tests 71 passed (71)`. Write the actual numbers into the PR body. **Freeze `/tmp/p2-control-files.txt` too** (#1779): a later batch (3, 5, 6) creates a new integration test whose filename matches this same `order|cart|payment|inventory|bundle` grep, so the post-change file count and test count legitimately GROW — Step 6 compares against this frozen list plus each control file's own pass/fail, never against the raw count.

- [ ] **Step 5: Fix, test, mutation-prove**

Per finding that reproduces: write the failing test first, fix, confirm it passes, then break the fix and name the reddening test, then restore and `diff` to prove byte-identical. Prefer asserting BEHAVIOUR over source text — a source grep proves the characters exist, not that the code runs (this exact weakness shipped a checkout dead-end on 2026-09-12).

- [ ] **Step 6: Re-run the money-path suite and compare to the control**

```bash
npx vitest run $(cat /tmp/p2-control-files.txt) $(ls tests/integration/*.test.ts \
  | grep -iE "order|cart|payment|inventory|bundle" | grep -vFxf /tmp/p2-control-files.txt) \
  2>&1 | grep -E "Test Files|^ *Tests |✓|×"
```

**Every file listed in `/tmp/p2-control-files.txt` must still pass** (#1779). A test count
INCREASE caused by a batch's own new test (Batch 3's `cart-nested-transaction.test.ts`,
Batch 5, Batch 6) is expected and is NOT a gate failure — only a pass→fail transition in a
frozen control file is. If a control file fails, stop: the change broke something.

- [ ] **Step 7: Commit, PR, and close the non-reproducing findings**

Stage explicit paths. PR body states: the control numbers, the mutation results, and one line per finding (fixed / did-not-reproduce). Close the non-reproducers with their evidence.

- [ ] **Step 8: After merge, verify production**

```bash
curl -s https://api.ebda.app/health     # commit must equal origin/main
psql "$PROD" -At -c "select count(*) from payments where status::text in ('failed','cancelled') and created_at > now() - interval '1 hour';"   # expect 0
curl -s -o /dev/null -w '%{http_code}' -X POST "https://api.ebda.app/api/v1/stores/$SID/cart/items" \
  -H 'Content-Type: application/json' -H "X-Session-ID: verify-$(uuidgen)" -d "{\"productId\":\"$PID\",\"quantity\":1}"  # expect 201
```

---

## Batch 1: `auth.service.ts` — the refresh-token rotation race

**Findings:** #1671, #1683, #1684, #1687, #1688, #1691
**Files:** Modify `apps/api/src/services/auth.service.ts`; Test `tests/unit/refresh-token-rotation-race.test.ts` (**already exists** — extend, do not create)
**Exposure:** every login. NOT a money-path file, so the hard rule's step 6 is a regression check rather than a gate.

**Status (#1785, corrected 2026-09-25): four of six are ALREADY FIXED, on `main`.**
Commit `2333d8c0` ("fix(auth): bound the rotation-race grace path's consequence,
not just its window", PR #1774) closed #1684, #1687, #1683 and #1688 before this
plan's Step 1 was ever run against them — an executor opening this batch as
originally written would re-derive the window-only fix over code that already
has the stronger one, and the prescribed commit subject below is the exact
framing that fixed commit explicitly rejects ("The window bounded the
OPPORTUNITY to replay a rotated token. It bounded nothing about what replaying
one paid out."). **Only #1671 (token-family lineage) and the absolute-lifetime
half of #1691 remain**, both deliberately deferred — see Rulings P2-B1-1 and
P2-B1-2 in `docs/RULINGS.md` for what was decided and why (P2-B1-2: closing
#1671 needs a `familyId` column, a migration and a backfill).

**Interfaces:**

- Consumes: `ROTATION_RACE_GRACE_MS`, `successorChainIsLive()`, `ROTATION_RACE_MAX_CHAIN_HOPS` — all already in `auth.service.ts`.
- Produces: nothing other tasks depend on.

Scope is now the remainder only. Do not re-touch the four already-fixed findings or their mechanism.

- [ ] **Step 1: Verify #1671 and the absolute-lifetime half of #1691 still reproduce**, and re-read Rulings P2-B1-1/P2-B1-2 for what a fix needs (the `familyId` column + migration + backfill).
- [ ] **Step 2: Write the failing test(s)** for whichever half of this Ahmad approves fixing — Rulings P2-B1-1/P2-B1-2 recorded these as deferred, not rejected, so confirm scope before writing the migration.
- [ ] **Step 3: Run them — expect FAIL**
- [ ] **Step 4: Fix**
- [ ] **Step 5: Run — expect PASS**
- [ ] **Step 6: Mutation-prove** — restore byte-identical.
- [ ] **Step 7: Register** the new defence(s) in `docs/security/defence-mutations.json` alongside the four already there (`session-rotation-grace-budget`, `session-rotation-backlink-cas`, `session-revocation-midflight`, `session-rotation-grace-no-clock-renew` — NOT `auth-rotation-grace-bounded`, which does not exist in the spec).
- [ ] **Step 8: Commit** — do not reuse "fix(auth): bound the rotation-race grace window" as the subject; that framing is what the merged fix corrected.

```bash
git add apps/api/src/services/auth.service.ts tests/unit/refresh-token-rotation-race.test.ts \
  docs/security/defence-mutations.json docs/security/defence-mutation-record.md
```

---

## Batch 2: `security.ts` — origin gates

**Findings:** #1240, #1310, #1330, #1690
**Files:** Modify `apps/api/src/middleware/security.ts`; Test `tests/unit/csrf-merchant-origin.test.ts` (extend)
**Exposure:** every request.

**Note:** #1530 and #1717 from this file were fixed in PR #1759 and closed on 2026-09-12 — do not re-fix them. That leaves four.

**A trap this plan already hit:** GitHub closes only the FIRST issue in a
comma-separated `Closes #a, #b, #c` list. #1759 named five and closed one; the
other four sat open, fixed, looking like work. Write `Closes #a, closes #b,
closes #c` — one keyword per issue — or close them by hand after merge and say
which commit fixed them.

- [ ] **Step 1: Verify the four reproduce.** #1330 (allow-list-first inverts the fail-closed guard) is the load-bearing one; #1240 and #1310 are consequences of the same ordering.
- [ ] **Step 2-8:** follow the per-batch procedure. Assert BEHAVIOUR by calling the middleware, never by grepping the source — `csrf-merchant-origin.test.ts` already has the `makeReq`/`makeRes` harness for this.

---

## Batch 3: `cart.service.ts` — nested transactions

**Findings:** #1109, #1581, #1584, #1592, #1583, #1766
**Files:** Modify `apps/api/src/services/cart.service.ts`; Test `tests/integration/cart-nested-transaction.test.ts` (create)
**Exposure:** 10,264 carts. **MONEY PATH — the hard rule applies in full.**

#1109, #1581 and #1592 are three reports of one defect (`addItems` opens a nested `$transaction` under the ambient tenant tx). Fix once, close three.

#1584 (retry backoff sleeping inside the request transaction) must be fixed in the same PR: it holds a pooler connection for the backoff duration, and under the concurrency this path already sees that is how the pool exhausts.

- [ ] **Step 1-4:** per-batch procedure, including the `origin/main` control.
- [ ] **Step 5: Write a failing integration test** that drives `addItems` under an ambient `runInTenantContext` and asserts no nested transaction error.
- [ ] **Step 6-8:** per-batch procedure. Step 6's comparison is a **gate**, not a check.

---

## Batch 4: `apps/web/src/lib/api.ts` — the CSRF self-heal

**Findings:** #1243, #1256, #1526, #1528, #1537
**Files:** Modify `apps/web/src/lib/api.ts`; Test `apps/web/src/lib/api-csrf-heal.test.ts` (create)
**Exposure:** every storefront write. #1537 ("self-heal costs the shopper one unpaid order") touches checkout — **treat as money path.**

---

## Batch 5: checkout surfaces

**Findings:** the 8 on `CheckoutClient.tsx` plus `OrderSummary.tsx`, `types.ts`, `SuccessClient.tsx`
**Exposure:** every checkout. **MONEY PATH.**

Render-assert, do not source-grep. `tests/unit/checkout-error-alert-renders.test.tsx` shows the `react-dom/server` pattern this repo uses (there is no jsdom).

---

## Batch 6: `order.service.ts` + the LIVE half of `order.routes.ts`

**Findings:** 8 on `order.service.ts`; #1699 only from `order.routes.ts`
**Exposure:** 143 orders. **MONEY PATH.**

The other 6 `order.routes.ts` findings are refund-path — they belong to Batch 10, not here. Splitting the file across two batches is deliberate: it keeps every money-path change in a PR whose control run means something.

#1699 (`Order.currency` is unvalidated free text feeding a throwing converter) is the highest-value item in this batch and is **related to the dormant `formatPrice` defect** — see Standing Items below. Do not fix one without reading the other.

---

## Batches 7-9: lower exposure

Storefront SEO (12), admin surfaces (30), CI/tooling (54). Same procedure; step 6 is a regression check, not a gate, because none touch the money path. Batch 9 is the cheapest 54 findings in the backlog and can be done in one sitting.

---

## Batches 10-11: never-executed code

**Batch 10** — the gateway refund path (~30 findings across `payment.factory.ts`, `order.routes.ts`'s refund half, `refund-settlement.ts`, `order-refunded.ts`).
**Batch 11** — `return.service.ts` (16), `loyalty.service.ts` (8), partial-return posting (4).

Both are sequenced LAST on evidence: **0 refunds and 0 returns have ever been created in production.** Every finding in them is reasoning about code that has not run.

Two consequences for the executor:

1. There is no production signal to verify against. Step 8 cannot prove anything for these batches — say so in the PR rather than implying it did.
2. `return.service.ts`'s 6 "stranded return" findings (#1349, #1361, #1423, #1448, #1478, #1431) describe a **deliberate, documented choice**: the completion claim is retained after a gateway refund because those are terminal with no undo API. The real gap is that the code says "reconcile manually" and ships no way to do it. Build the operator recovery surface; do not remove the retention.

---

## Standing items (not in any batch)

These are known, recorded, and deliberately outside the batch sequence.

- [ ] **`formatPrice` non-EGP divisor.** `packages/shared/src/utils/index.ts:63` divides non-EGP by 100 while the admin write path multiplies by 1000 for EVERY currency — a non-EGP store would display prices 10x too high. Dormant: all three production stores are EGP. Store currency is bare `z.string()`, so nothing prevents a fourth. Pairs with #1699.
- [ ] **`store_usage_snapshots` has no RLS.** Ruling MCP-1 records why it was not swept inside an MCP PR: it holds production rows, so enabling RLS on it is a production action needing its own change, probe and rollback.
- [ ] **`AI_FIX_PAT` lacks the `workflows` scope.** Ahmad's action in the GitHub UI. Until then the auto-fix job cannot land a workflow fix; PR #1756 makes it degrade gracefully rather than discard the rest.
- [ ] **MCP merchant-admin phases 2 and 3** — writes, then destructive ops with `confirm_token`. Specced in `docs/superpowers/specs/2026-09-11-mcp-merchant-admin-design.md`.
- [ ] **Deleted-product cart-line highlighting** — needs a per-item `unavailable` flag on the cart read plus a `CartClient` state.

## Definition of done

- 0 open `audit-followup` issues, each either fixed-with-a-test or closed-with-evidence.
- Every file frozen in the money-path control still passes at every merge (new tests a batch adds are additive, not a mismatch — see Step 6).
- Every security fix registered in `defence-mutations.json` with its source file reachable from the mutation workflow's `paths`.
- Production verified after each money-path merge: `/health` commit equals `origin/main`, zero failed payments since the deploy, guest cart round-trip 201.
