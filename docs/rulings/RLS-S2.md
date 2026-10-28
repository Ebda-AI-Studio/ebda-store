# RLS-S2

> Section: 2026-09-25 — RLS strict policies (cutover attempt #1 rollback)

**Ruling RLS-S2 — `prisma.$transaction` opened inside a context inherits that context's GUCs.**
Measured under a real the earlier app role login: inside `runInTenantContext`, a strict-table count was 2
directly and 0 through `withMoneyTx` or a batch `$transaction([...])`. Fixing it in the proxy covers
all 23 `withMoneyTx` and ~20 batch call sites at once. The transaction still opens separately (no
nesting, callers keep their isolation/timeout options). Inert on the owner role. Cost if wrong: a
caller that deliberately used a second transaction to escape its store's scope now sees only its
store — none was found, and such a caller would itself be a tenancy bug.
