# RLS-S1

> Section: 2026-09-25 — RLS strict policies (cutover attempt #1 rollback)

**Ruling RLS-S1 — the 24 STRICT policies stay strict; the readers get a context.** Weakening
`store_faqs`/`store_howtos` (or any of the 24) to allow-contextless would make the public-route bug
disappear by removing the database backstop the cutover exists to add, and no migration or doc
records allow-contextless as the intended shape for them. Every contextless reader found was given
the store it had already resolved. No policy migration ships. Cost if wrong: a contextless reader
the audit and the parity gate both missed returns empty after the next flip — bounded by the
parity gate, the staging soak list, and a one-env-var rollback.
