# DEPLOY-SAFETY-3

> Section: 2026-10-08 - Deploy safety after the `Prisma.dmmf` outage (branch `ci/deploy-safety`)

Ruling DEPLOY-SAFETY-3 - rolling code back does not roll the database back. The API migrates production before it deploys (CF-MIGRATE-1), so after an auto-rollback the schema is at the NEW version while the OLD code serves. This is safe only while migrations stay expand-then-contract; the guard prints that warning on every rollback path and the workflow comment repeats it. A contract migration (a drop, an `ENABLE/FORCE RLS` the old code cannot satisfy) must ship in a later deploy than the code that stops needing the old shape, as in R-EBDA-005. A Durable Object class migration in `wrangler.jsonc` (tag `v1` today) is likewise not undone by a code rollback. Cost if wrong: an auto-rollback after a non-backward-compatible migration swaps one outage for another; the job output says so and the operator restores compatibility by hand.
