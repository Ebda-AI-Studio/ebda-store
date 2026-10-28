# BUILDER-PURGE-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-PURGE-1 — publish/rollback purge every cache layer with `bustStoreCaches` queued by `deferAfterTenantCommit` (after COMMIT, so no reader re-caches the pre-commit value). A failed purge is logged at error level and does NOT fail the publish (the file plan suggested 503 + P1): the write is already committed, and the storefront fetch revalidates within 60s. Residuals, NOT verified: the OpenNext incremental cache layer (file plan row 4) and the browser `max-age=60` on the public layout (already accepted in LAYOUT-PURGE-1); nothing here is deployed, so no live purge timing exists. Mutations: delete the purge call, the bust inside it, or read drafts publicly → tests redden. Cost if wrong: up to 60s of stale homepage after a publish whose purge failed.
