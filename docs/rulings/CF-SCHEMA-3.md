# CF-SCHEMA-3

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling CF-SCHEMA-3 (2026-10-24) - the Store model (105 columns, over the 100-column Durable Object limit) is split by where each column is read (`scripts/store-split.mjs`): `d1Only` and `mirror` columns in D1 `stores` (slug and domain unique there only), `mirror` + `profile` in DO `store_profile`, the rest in DO `store_config`; a new Store column defaults to `store_config` and the 105-column pin in `store-split.test.ts` forces a conscious placement. The mirror write-through goes through the DO `d1_outbox` retried by alarm. Cost if wrong: a column in the wrong bucket is moved by editing one list and regenerating.
