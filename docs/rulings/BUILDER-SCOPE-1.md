# BUILDER-SCOPE-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-SCOPE-1 — Phase 1 includes persisted draft/publish/revisions/rollback (the file plan put storage in Phase 3 and said "no migration in Phase 1"). Evidence: Ahmad's Phase 1 brief, 2026-10-07. Consequence: migration `20261007170000_store_page_revisions` (additive, strict RLS, FK cascade) lands now; revision retention (keep last 50) and builder permissions stay in Phase 3. Cost if wrong: an unbounded revision table per store until retention lands — one row per publish, ≤ 256 KB each (DB CHECK).
