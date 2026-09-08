# Handoff — PR #1596 x #1587 semantic merge (tenant tx: commit / respond / drain)

_Updated 2026-09-08. Branch `fix/tenant-tx-commit-before-respond`, worktree
`_worktrees/force-website-builder__fix-tenant-tx-commit`. Merge commit
`3ab7052c` (parents `14598a28` + `ba404ae0`), payments fix `f7b533a7`,
pushed and confirmed via `git ls-remote`._

_The previous contents of this file described the 2026-09-02 audit-record
work (PR #1133) and were 6 days stale for this worktree. That work is done;
nothing below relates to it._

## Goal

Resolve the SEMANTIC conflict between PR #1596 (this branch — the request
transaction COMMITS BEFORE the response is flushed) and PR #1587 (already on
`main` — `deferAfterTenantCommit()` work runs AFTER that transaction, in a
fresh tenant transaction carrying the same GUCs), so BOTH properties hold, and
prove it. Standing instruction from Ahmad: **nothing breaks.**

## Current state

Merged, tested, mutation-checked, documented, committed and pushed. PR #1596
body updated to describe the combined behaviour. **The PR is deliberately NOT
merged** — that was out of scope.

## Done

- **The ordering decision**, which is the whole merge:
  `COMMIT -> response released to the client -> deferred work drains`.
  `runRequestInTransaction`'s `open` gained a second argument
  (`releaseResponse`); `withDeferredWork` gained an optional `onCommitted` and
  calls it between the commit and the drain. Rollback / failed COMMIT reach
  neither step and drop the queued work.
- `drain()` documented + coded as never-rejecting (the response is already
  gone by then; a throw could only mislabel a delivered request).
- **Two new test files for the COMBINATION** (neither PR had one):
  `apps/api/src/middleware/__tests__/deferred-work-lifecycle.test.ts` (8) and
  `tests/integration/deferred-work-lifecycle.test.ts` (6, real Postgres,
  asserts both GUCs via `current_setting(...)`).
- **All 8 required properties mutation-checked** — each broken, the reddening
  test named, the file restored byte-identically (sha256 verified). Mapping is
  in the PR body and in the report at
  `/private/tmp/claude-501/-Users-ahmadsharaf/8114e120-ace4-400a-97e8-6af73646e361/scratchpad/tenant-tx-merge-report.md`.
- **Blast-radius sweep → found + fixed 11** (5 new in this merge): stale
  "tx held until res.finish" claims in `shipping/customers/order.routes.ts`,
  `order.service.ts`, `rls-router-context-invariant.test.ts`.
- **Documentation parity**: ADR 0001 Consequences, the `CLAUDE.md` RLS bullet
  and `docs/audits/2026-09-08-post-response-tenant-tx-p2028.md` now describe
  the COMBINED behaviour, not either half.
- **Zero regressions** vs the `origin/main` baseline: unit (CI glob) 232/2664 →
  232/2664; integration 97 files/591 → 101/632 (+4 files, +41 tests); e2e
  11/111+3skip unchanged; typecheck clean; lint 0 errors/143 warnings (same).

## CI round 2 — a real money-path defect, found and fixed

The first CI run on `0c7c1293` went red on ONE test:
`export-response-lifecycle.test.ts > POST /payments/create still works`.

- **The reported error was attempt 2, not the failure.** `retry: 1` masked it:
  attempt 1 = `expected null not to be null`, attempt 2 = P2002 on
  `paymentConfig.create` colliding with attempt 1's own row.
- **Attempt 1 was real, and measured.** Instrumenting `runInTenantContext` with
  commit timestamps showed `POST /payments/create` sending its 200
  **0.376 ms before its own COMMIT landed** — `res.json(...)` was called from
  inside its own `runInTenantContext`. The same log shows
  `POST /stores/:id/orders` (under `tenantContext`) committing BEFORE its
  response, i.e. this PR working.
- **Not a regression from this branch** — `payment.routes.ts`,
  `runInTenantContext` and `PaymentService` are untouched by the merge; the
  behaviour is byte-identical on `main`. The PR's mount claim is still correct.
- **Fixed, not tolerated** (commit `f7b533a7`): the callback returns
  `{ status, body }` at all three exits and the send happens after the
  transaction resolves. Re-measured: COMMITTED 605.092 → response-finished
  605.296 → client 605.569.
- **Class swept:** a scanner over all of `apps/api/src` finds exactly one other
  `res.*`-inside-a-tx hit, and it is a `fetch` Response reading a body. Not a
  defect. `payments/create` was the only site.
- **Deterministic gate added:**
  `tests/unit/response-outside-tenant-transaction.test.ts` fails on any such
  send, naming `file:line`, and carries its own negative control. Mutation-
  checked (reddens with `routes/payment.routes.ts:416`), restored byte-identically.
- **Retry-safety swept in that file:** `paymentConfig.create` → `upsert`, and
  the `beforeAll` cart → per-CALL `placeCodOrder()`. The durability assertion
  itself was NOT softened.
- Whole integration suite re-run with `--retry=0`: **101 files / 632 green**,
  so nothing else in it leans on a retry.

## In progress

Nothing.

## Left to do

- Review + merge PR #1596 (explicitly left to Ahmad).
- **Not proven, stated openly:** a real Postgres COMMIT-time failure was never
  induced — property 2 is proven at unit level (real socket, real middleware,
  fake transaction) plus by #1596's own suite. Inducing a genuine commit-time
  failure needs a DEFERRABLE INITIALLY DEFERRED constraint fixture, which is a
  DDL change to the test schema and was judged out of scope.
- **Worth a follow-up:** the online-provider branch of `payments/create` calls
  the external gateway (`PaymentService.createPayment`) from INSIDE the tenant
  transaction. Pre-existing, untouched here, and bounded by the 30s tx timeout —
  but an external call inside a DB transaction is its own smell.
- **Flagged, not changed:** `hasDeferralScope()` (exported by #1587) has zero
  production call sites — only tests. Pre-existing on `main`.

## Notes

- Local test recipe: a foreign `tsx watch` from another project holds `*:4000`
  (IPv6). Bind the FWB API to `127.0.0.1:4000` (macOS `v6only=0` still allows
  the more specific IPv4 bind, verified) and run vitest with
  `--dns-result-order=ipv4first --no-network-family-autoselection`.
  DB: `postgresql://test:test@127.0.0.1:5432/force_test`, already migrated +
  seeded.
- `vitest.config.ts` sets `retry: 1`. It masked a real flake in the new
  integration file during authoring (an assertion that the deferred task had
  already STARTED — it legitimately may not have). Run the guard set with
  `--retry=0` when judging stability.
