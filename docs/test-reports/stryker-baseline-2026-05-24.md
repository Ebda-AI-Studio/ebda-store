# Mutation testing baseline — FWB — 2026-05-24

## Per-module score

| Module                    | Mutants  | Killed | Survived | No Cov  | Score                        |
| ------------------------- | -------- | ------ | -------- | ------- | ---------------------------- |
| auth.service.ts           | 621      | 0      | 0        | 621     | 0.00%                        |
| payment.service.ts        | —        | —      | —        | —       | not measured (no unit tests) |
| recommendation.service.ts | 271      | 97     | 74       | 199     | 26.22%                       |
| ai-quota.ts               | 47       | 0      | 0        | 47      | 0.00%                        |
| **All files**             | **1054** | **97** | **74**   | **867** | **9.34%**                    |

Note: `payment.service.ts` matched 0 files — the actual file path in the monorepo resolves through
a different import path. The 1054 mutants above are across the 4 configured source files.

## Top surviving mutants (5 examples)

- `recommendation.service.ts:271`: `p.id === id` → `p.id !== id` — survived because test only checks
  exclusion of cart items, not that the correct product is selected (equality reversal not detected).
- `recommendation.service.ts:264`: `status: 'active'` → `status: ""` — survived because the mock
  returns fixed data regardless of the filter value passed to the DB call.
- `recommendation.service.ts:271`: `.filter(Boolean)` removed — survived because tests don't assert
  on null/undefined filtering in the result array.
- `recommendation.service.ts:271`: `() => undefined` (map callback) — survived because test only
  checks cart exclusion, not that the map produces correct items.
- `recommendation.service.ts:271`: `find(() => true)` — survived because test input is small enough
  that first-match always includes some valid product.

## Root cause of 0% coverage on auth.service.ts and ai-quota.ts

The vitest unit tests (`tests/unit/auth.test.ts`, `tests/unit/payment-provider.test.ts`) mock the
service layer heavily. `auth.service.ts` is never imported directly in unit tests — `tests/unit/auth.test.ts`
tests the JWT helper, not the service class. `ai-quota.ts` has no unit test file. Both would need
integration tests or dedicated unit tests that import the actual module (not mocks).

## Interpretation

9.34% is a first-run baseline on modules with **no dedicated unit test coverage**. The recommendation
module is the only one partially covered (26.22% — covered portion is 56.73%). The auth service and
AI quota module are entirely untested at the unit level, so every mutant survives trivially.

Industry typical is 60–80% on well-tested codebases. Fix path:

1. Add unit tests for `auth.service.ts` key methods (token generation, validation, refresh logic)
2. Add unit tests for `ai-quota.ts` (quota check, increment, daily/monthly cap logic)
3. For `recommendation.service.ts`: strengthen assertions — test that specific product IDs appear in
   output, not just that excluded IDs are absent.

## How to re-run

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder
npx stryker run stryker.conf.json
```

HTML report: `docs/test-reports/stryker-baseline-2026-05-24/fwb/mutation.html`
