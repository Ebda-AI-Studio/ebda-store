# CL-2

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-2 — cross-store aggregates reached from inside a store scope run
under `withRlsBypass`, and are gated in the the earlier app role suite (issue 2040,
issue 2043).** `assertAiQuota`'s daily/monthly counts protect ONE Google project
ceiling; the per-store slice stays ambient. The mirror of RLS-S1: the strict
list names readers that NEED a context, and `rls-ebda-app.test.ts` now carries
a "must NOT be scoped" block for readers that must not have one. Proven red on
the pre-fix code under a real non-BYPASSRLS login (a role that is a member of
the earlier app role). Cost if wrong: none on isolation — the two counts only read
`count(*)`, never row contents.
