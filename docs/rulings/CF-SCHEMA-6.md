# CF-SCHEMA-6

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling CF-SCHEMA-6 (2026-10-24) - security review finding: the boolean rewrite (`col` -> `col = 1`) now applies ONLY to CHECK bodies and partial-index WHERE predicates (`pgPredicateToSqlite`), never to index column lists, which had turned `UNIQUE (shipment_id) WHERE ...` into `UNIQUE (shipment_id = 1)` (3 single-column partial uniques were wrong: shipment_pickups_one_active, customer_groups_one_default_per_store, provider_activation_requests_one_live). `raw-index-parity.test.ts` diffs every translated index against its Postgres original (table, uniqueness, column list, WHERE) and pins the behaviour (two shipments may each hold an active pickup; a second active pickup for one shipment is refused). Cost if wrong: a mistranslated unique would silently allow or forbid rows; the per-index diff makes that a red test.
