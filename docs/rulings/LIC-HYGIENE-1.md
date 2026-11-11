# LIC-HYGIENE-1

> Section: 2026-11-11 licensing-metadata hygiene (branch `chore/licensing-hygiene`)

**Ruling LIC-HYGIENE-1 - the five "skipped" tests are env-gated by design, not dead; four stay, one moves out of the test glob.**
An offline licensing analyzer counted static `test.skip(...)` calls. Read in context, none is an unconditional skip:

- `tests/builder-e2e/perf.e2e.ts` (5): skips on non-chromium, on viewports with no defined budget, and the Fast-4G test only without `PERF_INTERACTIVE_PROD=1`. Runs under the builder config on chromium at 1280/390. Kept.
- `tests/editor-live-e2e/editor-inert.e2e.ts`: runs when `INERT_E2E=1` (needs the demo showrooms on the local stack). Kept.
- `tests/editor-live-e2e/touch-second-tap.e2e.ts`: runs when `TOUCH_E2E=1` (same stack). Kept.
- `tests/smoke/commerce-b0.spec.ts` (1, ~50 assertions): skips only when the local B0 stack is down; with `B0_REQUIRE_STACK=1` it FAILS instead, so a gate run cannot pass by skipping (guard test `tests/unit/commerce-b0-spec-guards.test.ts`). Kept.
- `tests/prelaunch/signup.manual.spec.ts`: manual by design (needs a real inbox, hits production). Moved to `scripts/manual/prelaunch-signup.manual.ts` with `playwright.manual.config.ts`, so no test glob picks it up.
  Cost if wrong: an env-gated suite nobody sets the env for silently never runs; mitigated by `B0_REQUIRE_STACK` for the revenue flow, residual for the editor e2e pair.

**Ruling LIC-HYGIENE-2 - test-only dead helper files are deleted only when nothing imports them.** See the PR body for the list. Cost if wrong: a helper loaded by a dynamic path string is removed; CI typecheck + tests would fail loudly.
