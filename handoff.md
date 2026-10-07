# Ebda pricing handoff

## Goal

Implement Ahmad’s locked Basic/Growth/Business table; leave Amelia last.

## Current state

Branch codex/ebda-pricing in /private/tmp/ebda-pricing-20261005, based on origin/main 89461087. Local changes, not merged or deployed. Root plan checkout preserved, including its existing pricing documentation commit and unrelated .handoff files.

## Done

- Locked decision copied into docs/plans/2026-10-05-pricing-decisions.md.
- Forward catalog migration adds Basic/Growth/Business prices, staff/order limits, unlimited products, custom domains, zero fees; hides historical free/pro rows without reassigning stores.
- Self-serve provisioning creates a 14-day Growth trial atomically.
- Shopper/admin order creation checks expired trials and seven-day order grace.
- Bilingual marketing/help prices updated, annual totals displayed.
- 21 focused catalog/grace/schema/route tests pass; shared/API/marketing typechecks pass.
- Blast-radius sweep across apps/packages/docs/scripts/CI found old draft research tiers, marked superseded. Historical migrations preserved.

## In progress

Full entitlement implementation remains incomplete: stores (1/1/3), branding removal, merchant API/webhook access, analytics/support tiers lack plan gates.

## Left to do

- Implement remaining entitlements; review compatibility with legacy feature tiers and all store writers.
- Apply migration to an isolated test DB; exercise signup/trial/billing and checkout in integration/browser tests. No live DB or production behavior was verified.
- Ensure feature caches are invalidated for stores on changed catalog plans when releasing migration.
- Commit and PR after complete review; deploy requires service credentials. Amelia stays last.
- Memory/graph prerequisites: expected GRAPH_REPORT.md, vault ebda project note, root MEMORY.md and ~/.Codex/scripts/new-task-worktree.sh were absent at supplied paths. No memory pipeline was run.

Ruling R-EBDA-PRICING-1 — Keep historical free/pro/comped identifiers hidden for compatibility. Existing subscription foreign keys reference them. Cost if wrong: explicit legacy migration needed later.
