# TRC-2

> Section: Tenant routing canary (2026-10-01, branch `feat/tenant-routing-canary`, PR 1979)

**Ruling TRC-2 — issue 709 is fixed by single ownership, not by the root-layout decomposition the
issue proposed.** The tenant-store layout returns before emitting the theme `<style>`, the
Organization JSON-LD and the pixel provider while `ROOT_LAYOUT_OWNS_STORE_CHROME` is true, so the
root layout is the one writer on both trees. `tests/unit/web-tenant-tree-store-chrome-render.test.tsx`
renders both real layouts composed as Next composes them and asserts exactly one of each with the
flag off and on; flipping the constant, removing the early return, or removing the root's pixel
provider each turn it red. The source guard no longer passes vacuously when the root stops mounting
the provider (review comment on the PR). Cost if wrong: the decomposition PR must flip the constant
in the same change, or the render test fails, which is the intended alarm.
