# B2B-TEN-1

> Section: B2B wholesale pricing (feat/b2b-wholesale, 2026-10-21)

Ruling B2B-TEN-1 - Tier / group / application ownership is enforced by composite FKs, not only by the service (migration `20261028000300`): tiers `(store_id, product_id)`, `(product_id, variant_id)`, `(store_id, group_id)`; applications `(store_id, user_id)`, `(store_id, group_id)`; customers `(store_id, group_id)`. The single-column FKs are kept (the Prisma relations sit on them). Cost if wrong: a service validation bug persists garbage rows that a later refactor starts charging.
