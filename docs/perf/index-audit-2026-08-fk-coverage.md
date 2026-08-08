# Index Audit — 2026-08-08 — foreign-key coverage

Follow-up to [`index-audit-2026-05.md`](./index-audit-2026-05.md), which audited
indexes by **query** (`pg_stat_user_indexes` + `EXPLAIN`). This one audits them by
**constraint**: every `@relation(fields: [...])` in `schema.prisma` checked against
the indexes on its own model.

Static analysis of the schema only — no production `EXPLAIN` was run (see
"Not verified against production" below).

## Why FK coverage is a separate question

Postgres creates an index for the **referenced** (parent) side of a foreign key —
that's the PK. It creates nothing on the **referencing** (child) side. Every
parent delete then fires an RI trigger that queries the child on the FK column
alone:

```sql
UPDATE <child> SET <fk> = NULL WHERE <fk> = $1   -- onDelete: SetNull
DELETE FROM <child>            WHERE <fk> = $1   -- onDelete: Cascade
```

If no index has that FK as its **leading** column, this is a sequential scan —
held under the parent row's lock, for the duration.

## Result: 102 models, 5 gaps

| Model        | FK column            | onDelete | Prior coverage                             | Verdict |
| ------------ | -------------------- | -------- | ------------------------------------------ | ------- |
| `Customer`   | `groupId`            | SetNull  | `(storeId, groupId)` — non-leading         | gap     |
| `Coupon`     | `customerGroupId`    | SetNull  | `(storeId, customerGroupId)` — non-leading | gap     |
| `Promotion`  | `customerGroupId`    | SetNull  | `(storeId, customerGroupId)` — non-leading | gap     |
| `Order`      | `appliedPromotionId` | SetNull  | **none**                                   | gap     |
| `OrderEvent` | `actorId`            | SetNull  | **none**                                   | gap     |

A composite `(store_id, group_id)` serves the merchant-facing read ("customers in
this group, in this store") correctly — it is not a redundant index and is not
being replaced. It just cannot serve a filter on `group_id` alone, because a
btree can only be range-scanned from its leading column inward.

**Impact before this change:** deleting a CustomerGroup, a Promotion, or a User
seq-scanned the child table. On `orders` and `order_events` — the two largest
tables in the schema, both append-mostly and only growing — that is a lock held
across a full-table scan on a live storefront.

**Fixed by:** `packages/database/prisma/migrations/20260808120000_fk_only_indexes`.

## Six models carry no `@@index` at all — all six are correct

`ProductOption` and `ProductOptionValue` (`@@unique([productId, name])` /
`([optionId, value])`), `AbandonedCartConfig` and `AffiliateConfig`
(`storeId @unique`), `Sequence` (`@@id([storeId, kind])`),
`AnswerEngineProviderConfig` (`engine @unique`). In each case the unique
constraint or composite PK already indexes the FK as its leading column.

Recorded here so the next auditor doesn't re-flag them.

## Not verified against production

This audit is static. It establishes that the _plans could_ be bad; it does not
measure that they _are_, and it carries no row counts. Two things still worth
doing against prod:

1. Confirm the five new indexes are actually being chosen, and that none of them
   sit at `idx_scan = 0` long-term (a never-scanned FK index still earns its keep
   as delete insurance, but the count is worth knowing):

   ```sql
   SELECT relname, indexrelname, idx_scan
   FROM pg_stat_user_indexes
   WHERE indexrelname IN (
     'customers_group_id_idx', 'coupons_customer_group_id_idx',
     'promotions_customer_group_id_idx', 'orders_applied_promotion_id_idx',
     'order_events_actor_id_idx'
   );
   ```

2. Re-check the four findings in the 2026-05 audit, whose row counts
   (21 orders, 287 products) are now three months stale.

## Re-run command

FK coverage is a schema property, so it re-runs offline with no DB connection:

```bash
python3 scripts/audit-fk-indexes.py
```

Exits non-zero and lists any FK column that is not the leading column of some
index on its own model. See `scripts/audit-fk-indexes.py`.
