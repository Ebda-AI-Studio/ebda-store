# BUILDER-REFS-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-REFS-1 — catalogue references (category slug, product ids) that are not found in the caller's store are WARNINGS on draft save / publish, not errors. Evidence: under strict RLS a foreign id is indistinguishable from a deleted one, and the storefront's product fetches are store-scoped (`X-Store-ID`), so a foreign id can never render; blocking would break today's Save for a merchant who deleted a product still named in a carousel. Mutation: drop the check → the warning tests redden. Cost if wrong: a stale reference stays in the document until the merchant edits it (it renders nothing, the carousel falls back as before).
