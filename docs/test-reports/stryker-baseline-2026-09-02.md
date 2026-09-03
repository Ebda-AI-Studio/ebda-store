# Mutation testing baseline — FWB — 2026-09-02

Re-run as part of PR #1133 (no separate plan file was ever committed): the
2026-05-24 baseline had sat for 3+ months with `thresholds.break: null` (no CI gate
possible) and zero references anywhere in `.github/workflows/` — a config that could
never fail. This run re-measures the same 4 files, sets a real `break` floor so a
regression below today's score fails CI, and wires a manual (`workflow_dispatch`)
CI job so the config is actually invocable instead of purely aspirational.

## Per-module score

| Module                    | Mutants  | Killed  | Survived | No Cov  | Score                         |
| ------------------------- | -------- | ------- | -------- | ------- | ----------------------------- |
| auth.service.ts           | 670      | 20      | 43       | 607     | 2.99%                         |
| payment.service.ts        | —        | —       | —        | —       | not measured (see note below) |
| recommendation.service.ts | 376      | 97      | 74       | 205     | 25.80%                        |
| ai-quota.ts               | 53       | 0       | 0        | 53      | 0.00%                         |
| **All scored files**      | **1099** | **117** | **117**  | **865** | **10.65%**                    |

Runtime: 24 seconds (fast — this is cheap to re-run, there is no excuse for
letting it go stale again).

## Comparison to the 2026-05-24 baseline

| Module                    | 2026-05-24 | 2026-09-02 | Delta |
| ------------------------- | ---------- | ---------- | ----- |
| auth.service.ts           | 0.00%      | 2.99%      | +2.99 |
| recommendation.service.ts | 26.22%     | 25.80%     | -0.42 |
| ai-quota.ts               | 0.00%      | 0.00%      | 0     |
| All scored files          | 9.34%      | 10.65%     | +1.31 |

`auth.service.ts` went from zero coverage to some (20/63 covered mutants killed) —
real improvement, still far from healthy. `ai-quota.ts` is unchanged: still zero
dedicated tests. `recommendation.service.ts` moved within noise.

## `payment.service.ts` — still not in the scored breakdown (open question, not re-investigated)

The 2026-05-24 baseline recorded this as "matched 0 files — the actual file path
in the monorepo resolves through a different import path." This run's log shows
`Instrumented 4 source file(s) with 1121 mutant(s)` (all 4 configured files DID
match this time — the `mutate` globs in `stryker.conf.json` are unchanged from
May), but the final score table only accounts for 1099 of those 1121 mutants
across the 3 files above; `payment.service.ts` never appears as its own row, and
grepping the full run log for `payment.service.ts:` (the per-mutant location
prefix every other file's mutants carry) returns zero hits. The 22-mutant gap
(1121 - 1099) is consistent with those being `payment.service.ts` mutants marked
`Ignored` (likely by `ignoreStatic: true` in the config, if the file's mutable
code is only in module/class-level static initializers) rather than actually
scored — but this is a plausible explanation, not a verified one; no error or
warning was logged either way. Flagging rather than guessing further: the
integration test suite (real HTTP server + DB) partially compensates for
`payment.service.ts` regardless of what mutation testing measures here — see
the falsification audit's note that integration tests cover payment internals
in a way the auth-service unit-mock gap does not.

## Interpretation (unchanged from May, still true)

10.65% is still a codebase where the highest-value files (auth, AI quota) are
barely or not covered at the mutation level — the unit suite is green against
these files for the wrong reason (it doesn't import the real modules), not
because the logic is well-tested. Fix path is the same as May's:

1. Add unit tests for `auth.service.ts` that import the real module (some
   progress since May — 20 mutants now killed vs 0 — but 607/670 are still
   uncovered).
2. Add a dedicated unit test file for `ai-quota.ts` (still zero tests).
3. Strengthen `recommendation.service.ts` assertions per the specific surviving
   mutants listed in the HTML report (equality-reversal, filter removal,
   always-true/false conditionals on the id-matching `find()` call).

## Ratchet

`stryker.conf.json`'s `thresholds.break` was `null` (nothing could fail). Set
to `10` initially — then LOWERED to `8` (audit-followup #1143): 10 sat only
0.65 points (~7 mutants of 1099) under the measured 10.65%, while this very
document records 22 instrumented-but-unscored mutants (`payment.service.ts`
has no row and the `ignoreStatic` explanation above is plausible, not
verified). If those 22 ever get scored — a config change, a Stryker minor
bump, a refactor out of static initializers — the denominator grows ~2% and
a 10 floor breaks on a PR that changed nothing about test quality. The `8`
floor is therefore DELIBERATELY below the measured score, not pinned to it;
re-ratchet toward the measured score once the payment.service.ts mutant gap
is explained. This is a floor, not a target: `low`/`high`
(60/80) stay as the aspirational healthy-score bar. A CI job
(`.github/workflows/mutation-testing.yml`, `workflow_dispatch`-only, matching
`load-test-nightly.yml`'s manual pattern) now runs `npx stryker run` and fails
if the score drops below the configured `break` — previously this config had
zero references anywhere in `.github/workflows/`, so `break` had no gate to
attach to no matter what it was set to.

## How to re-run

```bash
cd force-website-builder
npx stryker run stryker.conf.json
```

HTML report: `docs/test-reports/stryker-baseline-2026-09-02/fwb/mutation.html`

## What this score deliberately does NOT cover — and where that lives instead

An aggregate mutation score answers "how much of this file is exercised". It
cannot answer "if someone deletes THIS guard, does CI stop them?", and for the
controls that matter most the two questions diverge badly here:

- Stryker runs `vitest.stryker.config.ts`, whose `include` is `tests/unit/**`
  only. Every integration-defended control — the RLS session GUC, cross-tenant
  accounting scoping, GDPR erasure, refresh-token rotation — is structurally
  unreachable by it. Adding those source files to `mutate` would score them 0%
  for a reason that has nothing to do with test quality, and that 0% would then
  be enshrined as a `break` floor.
- It scores whole files. A file at 60% tells you nothing about whether the one
  line that enforces tenant isolation is among the 40% nobody tests.

The per-defence answer lives in **`docs/security/defence-mutation-record.md`**,
generated by `scripts/defence-mutation-record.mjs` from an explicit spec
(`docs/security/defence-mutations.json`). It removes one named guard at a time
and re-runs the single test that claims to cover it, across the five domains
the standard marks mutation-record-mandatory (authn/session, tenant/RLS,
money/payment/refund, consent, erasure). It runs on every PR touching a
defended source and fails on a SURVIVED defence.

The two are complementary: keep this score as the coverage trend, and treat the
defence record as the gate.
