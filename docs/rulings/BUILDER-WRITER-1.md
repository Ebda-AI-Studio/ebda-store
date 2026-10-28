# BUILDER-WRITER-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-WRITER-1 — `layout_settings` stays the compatibility source: publish and rollback back-write it from the document in the same transaction; the legacy `PUT /layout` keeps its contract but also records a published revision (it can no longer write behind the history); the public layout response carries the published document ONLY when its projection equals `layout_settings`, else the layout-derived document (an out-of-band script write wins, logged). Evidence: integration tests "legacy layout PUT publishes a revision", "out-of-band write wins". Cost if wrong: the equality check costs one projection per public layout request (cheap; the route already hits the DB).
