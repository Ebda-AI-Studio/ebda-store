# RLS-S4

> Section: 2026-09-25 — RLS strict policies (cutover attempt #1 rollback)

**Ruling RLS-S4 — the R2 orphan check runs under `withRlsBypass`.** "Is this URL referenced
anywhere" is cross-store by definition (cloned stores share image URLs); inside a store context
every other store's rows are invisible and the object would be deleted while still in use. Cost if
wrong: none on correctness — the check only ever reads, and bypass only widens what it can see.
