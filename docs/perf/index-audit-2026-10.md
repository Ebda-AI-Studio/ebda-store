# Index Audit — 2026-10-01

Follow-up to [`index-audit-2026-05.md`](./index-audit-2026-05.md) (by query) and
[`index-audit-2026-08-fk-coverage.md`](./index-audit-2026-08-fk-coverage.md) (by constraint).
Trigger: issue #2405 — the server-side order search from PR #2398 is an unindexed leading-wildcard
ILIKE on `orders` plus four relation filters on `users`.

**Source: production Neon (PG 17.11), read-only.** `DIRECT_URL` from Railway, session forced to
`default_transaction_read_only=on`; SELECT and EXPLAIN only, no DDL. `pg_stat_database.stats_reset`
is NULL and `n_tup_ins` matches each table's lifetime row count, so the counters below cover the
tables' whole history, not only the current compute's uptime. Scale test: a scratch PG 16 migrated
with `prisma migrate deploy`, seeded with 2 stores × 50,000 orders, 20,001 users and 25,000
`ai_usage` rows.

## Production shape

Every table is small. The largest are `ai_usage` 25,090 rows, `reorder_suggestions` 14,802,
`carts` 13,830, `cart_items` 5,483, `products` 501 and `orders` 188. `pg_stat_statements` is
**not installed** (only `pg_trgm` and `plpgsql` are), so no per-statement timings exist. The table
counters and EXPLAIN are the evidence.

Top tables by tuples read through sequential scans:

| Table                   |   Rows | Seq scans | Tuples read by seq | Idx scans | Verdict                                                                                                         |
| ----------------------- | -----: | --------: | -----------------: | --------: | --------------------------------------------------------------------------------------------------------------- |
| `ai_usage`              | 25,090 |    16,756 |    **140,509,044** |     6,924 | **Fixed**: platform-wide quota count with no usable index (below)                                               |
| `products`              |    501 |   243,792 |        122,825,102 | 1,767,747 | Planner's choice on a 500-row table. Storefront listing EXPLAIN is 0.26 ms                                      |
| `product_categories`    |    467 |   165,330 |         77,697,445 |   416,461 | Planner's choice (full-table hash joins on a ~10-page table)                                                    |
| `product_option_values` |    349 |   136,953 |         56,234,331 |    38,835 | Same                                                                                                            |
| `product_options`       |    141 |   234,183 |         38,901,809 |   381,274 | Same                                                                                                            |
| `cart_items`            |  5,483 |    11,130 |         19,289,006 |   175,874 | Not attributed. It needs `pg_stat_statements`                                                                   |
| `product_variants`      |    353 |    45,497 |         18,977,968 |   351,634 | Planner's choice                                                                                                |
| `carts`                 | 13,830 |     5,015 |         16,858,004 |   279,272 | Not attributed. It needs `pg_stat_statements` (the abandoned-cart sweep and funnel rollup EXPLAIN index-backed) |
| `categories`            |     47 |   176,917 |          8,712,585 |    75,076 | Planner's choice                                                                                                |
| `orders`                |    188 |    72,528 |          6,762,079 |   155,280 | Planner's choice today. Search fixed for scale (below)                                                          |

Also notable. These are tiny tables read on almost every storefront request, with 0 index scans:
`stores` 946,902 seq scans (3 rows), `warehouses` 179,000 (3 rows), `reviews` **178,118 (0 rows)**,
`store_features` 65,829, `store_pages` 61,470, `store_faqs` 61,326, `store_howtos` 61,324. No index
fixes these; they are each a cheap seq scan. They matter for Neon compute wake-ups
(`neon-audit` N6), not for latency. The `reviews` count is a read on every render of a table that
has never held a published row. That is a caching question, recorded here and not addressed in
this PR.

## Added — `20261002090000_order_search_trgm_and_fk_indexes`

| Index                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                    | Before → after                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders_order_number_trgm_idx` (GIN `gin_trgm_ops`)                      | #2405. `OrderService.listWhere` search: `order_number ILIKE '%t%'`. It runs twice per keystroke (findMany + count) from admin, the Orders PWA (plus a 30 s poll), the XLSX export and MCP `admin_list_orders`                                                                                                                                                                                               | 50k orders/store: 132–270 ms per query → **0.1–0.2 ms**                                                                                                                               |
| `users_{first_name,last_name,email,phone}_trgm_idx` (GIN `gin_trgm_ops`) | The same search's customer arms. All four are needed, because a BitmapOr needs every OR arm indexed                                                                                                                                                                                                                                                                                                         | Customer lookup: **0.2–1.1 ms** (BitmapOr + semi-join on `orders_store_id_customer_id_idx`)                                                                                           |
| `ai_usage_created_at_cached_hit_idx` (btree)                             | #1 table by seq-scan tuples in production. `lib/ai-quota.ts` counts `created_at >= day/month start AND cached_hit = false` across **all** stores before every AI call. The super-admin AI dashboard adds a `cached_hit = true` count. The existing indexes lead with `store_id`, `feature` or `model`, so every count is a seq scan (prod EXPLAIN: `Seq Scan … Rows Removed by Filter: 25045`, 501 buffers) | Day count 2.07 → **0.14 ms** and month count 2.09 → 1.34 ms (index-only). The seq scan grows with the table (~8k rows/month, no retention); the index scan grows only with the window |
| `cart_bundles_bundle_id_idx` (btree)                                     | The **only** one of 203 production FKs with no index leading on its column (`pg_constraint` vs `pg_index`; positive control: 202 of 203 matched). `ON DELETE CASCADE` from `bundles`. The `(cart_id, bundle_id)` unique has it second                                                                                                                                                                       | Bundle delete: seq scan of `cart_bundles` under the parent lock → index probe                                                                                                         |

## Added — `20261003100000_order_search_guest_contact_trgm_idx` (guest contact search)

`orders_guest_{first_name,last_name,email,phone}_trgm_idx`: partial (`WHERE customer_id IS NULL`)
expression GIN trigram indexes on `shipping_address ->> '<key>'`, the keys `customerKeyOf` reads.
`orderSearchWhere` resolves the matching guest order ids with one statement shaped to those indexes
(`guestOrderIdsSql`) and adds an `id IN (…)` arm to the same OR as the order number and the
registered customers. Registered customers' results are unchanged: a registered order is never
matched through its shipping JSON, only through the account, as before. Terms under 3 characters and
terms matching more than 1,000 guest orders fall back to an unindexed `shipping_address` JSON path
filter with the same rows.

Scratch PG 16, 2 stores × 25,000 orders (91.7 % guest, like production's 92.6 %), `ANALYZE`d:

| Statement (store-scoped, `LIMIT 1001`)      | Before (no index)                                       | After                          |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------ |
| rare first name `zubaidaneedle`             | 39.2 ms, 22,918 guest rows read and 22,916 filtered out | **0.62 ms**, BitmapOr of 4 GIN |
| phone fragment `51234567`                   | 30.7 ms                                                 | **0.42 ms**                    |
| email fragment `needle.guest`               | 31.9 ms                                                 | **1.12 ms**                    |
| rare last name `qurainneedle` (other store) | 32.4 ms                                                 | **0.12 ms**                    |

End to end through `OrderService.list` (customer lookup + guest lookup + page + count), warm:
38–45 ms → 9.5–14 ms for a rare term. The 4 indexes total 7.6 MB at 50k orders, build in 0.34 s,
and add no measurable insert cost (5,000 guest-order inserts: 171 ms → 174 ms). Production holds 188
orders today, so this is headroom for the first store that reaches 10⁴–10⁵ orders.

### Why the order search needed a query change, not just an index

Prisma 6.19 compiles `customer: { is: { firstName: contains } }` (one per field) into **four LEFT
JOINs onto `users`**. The OR then spans both sides of the join (captured from the query log):

```sql
… FROM orders LEFT JOIN users j0 ON j0.id = orders.customer_id … LEFT JOIN users j3 …
WHERE orders.store_id = $1 AND orders.deleted_at IS NULL
  AND (orders.order_number ILIKE $2 OR (j0.first_name ILIKE $3 AND j0.id IS NOT NULL) OR …)
```

No index can serve an OR whose arms sit on different tables. This was verified: with all five
trigram indexes in place and the query unchanged, the plan stayed four hash joins over the whole
store (153–167 ms). `OrderService.orderSearchWhere` therefore resolves the matching customers
first. The customer set is restricted to users with an order **in this store**, and deliberately
not filtered on `users.store_id`: in production, 13 of the 14 orders that have a customer point at a
user whose `store_id` differs from the order's store. The order filter then becomes
`order_number ILIKE $t OR customer_id IN (…)`, and Postgres answers it with a BitmapOr:

```
Bitmap Heap Scan on orders  (actual time=0.071..0.154 rows=33)
  Filter: ((deleted_at IS NULL) AND (store_id = 'storeA'))
  ->  BitmapOr
        ->  Bitmap Index Scan on orders_order_number_trgm_idx      Index Cond: (order_number ~~* '%augustus12%')
        ->  Bitmap Index Scan on orders_store_id_customer_id_idx   Index Cond: ((store_id = 'storeA') AND (customer_id = ANY (…)))
Execution Time: 0.205 ms          -- was 150.2 ms (count) / 168.8 ms (page) on main's shape
```

This returns the same rows by construction, and `tests/integration/order-search-indexes.test.ts`
pins it against the old relation-join shape for every term class. There are two fallbacks to the
relation filter, with the same rows and the unindexed plan: a term under 3 characters, which a
trigram index cannot serve, and a term matching more than 1,000 customers.

## Evaluated, not added

- **`orders (store_id, status, created_at DESC)`**. At 50k orders/store the status-filtered page
  plans an `Index Scan Backward` on `orders_created_at_idx` in 0.5 ms (rare status) and 4.5 ms (a
  common status at OFFSET 2000). The count uses `orders_store_id_status_idx` (28 ms for 5,000
  matches). Production: 0.10 ms. No evidence of a cliff (Ruling IDX-1).
- **Customers aggregate** (`customer-aggregate.service.ts`). It is `orders WHERE store_id AND deleted_at
IS NULL ORDER BY created_at DESC LIMIT 20001` and is served by `orders_store_id_created_at_idx`
  (23 ms for 20,001 rows at 50k; 0.16 ms in production). Nothing to add.
- **Storefront product listing**. Production plans `Index Scan Backward using products_created_at_idx`
  with 214 rows filtered, in 0.26 ms. `products_store_id_deleted_at_created_at_idx` exists already
  (from the 2026-05 audit) and the planner can switch to it as the store count grows. Nothing to
  add today.
- **`carts (store_id, created_at)`**. The funnel rollup's per-day `cart.count` bitmap-scans
  `carts_store_id_idx` and discards 8,552 of 8,614 rows (13 ms in production). It runs 7 times per
  store per day from the 02:00 cron, which is not a hot path (Ruling IDX-2).

## Unused-index removal candidates (dropped 2026-10-03, see the next section)

501 indexes. 329 have `idx_scan = 0`, but 147 of those are PK/unique and back a constraint, and
175 of the 182 non-unique ones sit on tables under 300 rows, where the planner correctly seq-scans.
A zero there says nothing about the index. Dropping was deferred to a separate change with its own
lock plan (Ruling IDX-3); that change is `20261003110100_drop_redundant_prefix_indexes` (Ruling DBM-1).

**Strongest candidates: left-prefix duplicates.** 37 non-unique btree indexes whose columns are a
strict left prefix, with the same sort order, of another btree on the same table. Any query they
serve, the longer index serves too, and FK support is kept by the longer index. The ones worth
dropping, by size and write traffic:

| Redundant index                                    | Size   | Covered by                                                            |
| -------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| `carts_store_id_idx`                               | 168 kB | `carts_store_id_session_id_key`                                       |
| `ai_recommendation_store_id_source_product_id_idx` | 80 kB  | `ai_recommendation_store_id_source_product_id_target_product_id_…`    |
| `audit_logs_store_id_idx`                          | 56 kB  | `audit_logs_store_id_created_at_idx`                                  |
| `orders_store_id_idx`                              | 16 kB  | `orders_store_id_created_at_idx` / `_status_idx` / `_customer_id_idx` |
| `products_store_id_idx`                            | 16 kB  | `products_store_id_status_idx` (+3 more)                              |
| `payment_events_event_type_idx`                    | 16 kB  | `payment_events_event_type_occurred_at_idx`                           |
| `inventory_history_store_id_idx`                   | 16 kB  | `inventory_history_store_id_reference_idx`                            |
| `cart_bundles_cart_id_idx`                         | 8 kB   | `cart_bundles_cart_id_bundle_id_key`                                  |

The other 29 are 8–16 kB each on tables with ≤ 80 rows (`warehouses_store_id_idx`,
`customers_store_id_idx`, `store_pages_store_id_idx`, …). Re-run the query below for the full list.

**Zero-scan, non-unique, on tables ≥ 300 rows (7):**

| Index                                      | Verdict                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ai_usage_feature_idx` (264 kB)            | **Keep**: the answer-engine budget count (`feature = … AND created_at >= …`) plans onto it (prod EXPLAIN); that path has not run yet |
| `inventory_history_store_id_reference_idx` | **Keep**: created 2026-10-01 (migration 20261001100000); zero only because it is new                                                 |
| `order_items_bundle_group_id_idx`          | Keep: bundles have no production rows yet                                                                                            |
| `product_variants_product_id_barcode_idx`  | Keep: barcode-scan and stock-adjustment lookups (`barcode-scan.service.ts`, `stock-adjustments.routes.ts`)                           |
| `product_variants_sku_idx`                 | Candidate: 32 kB. Re-check after the barcode/POS features see use                                                                    |
| `journal_lines_ref_table_ref_id_idx`       | Keep: accounting postings look up by `(ref_table, ref_id)`; the ledger is young                                                      |
| `order_events_actor_id_idx`                | **Keep**: supports the `order_events.actor_id` FK (`ON DELETE SET NULL` from users)                                                  |

## Dropped — `20261003110100_drop_redundant_prefix_indexes`

Owner-approved 2026-10-03. Verified read-only against production Neon (PG 17.11, `DIRECT_URL`,
session `default_transaction_read_only=on`) on 2026-10-03, per index. "Covering" is a valid, non
partial btree on the same table whose first columns equal the dropped index's, with the same sort
order. `pg_constraint.conindid` counts the constraints that use the dropped index as their backing
index: 0 for all eight (none is a PK, unique or exclusion constraint, none is the replica identity).

| Dropped index                                      |   Size | Scans (lifetime) | Longer index that keeps serving it                                                   |
| -------------------------------------------------- | -----: | ---------------: | ------------------------------------------------------------------------------------ |
| `carts_store_id_idx`                               | 168 kB |            8,891 | `carts_store_id_session_id_key` UNIQUE (store_id, session_id)                        |
| `ai_recommendation_store_id_source_product_id_idx` |  80 kB |           21,971 | `ai_recommendation_store_id_source_product_id_target_product_id_` UNIQUE (3 columns) |
| `audit_logs_store_id_idx`                          |  56 kB |               16 | `audit_logs_store_id_created_at_idx` (store_id, created_at DESC)                     |
| `orders_store_id_idx`                              |  16 kB |              196 | `orders_store_id_created_at_idx` (+ `_status_idx`, `_customer_id_idx`)               |
| `products_store_id_idx`                            |  16 kB |            1,263 | `products_store_id_deleted_at_created_at_idx` (+ `_status_idx` and others)           |
| `payment_events_event_type_idx`                    |  16 kB |              394 | `payment_events_event_type_occurred_at_idx` (event_type, occurred_at)                |
| `inventory_history_store_id_idx`                   |  16 kB |               31 | `inventory_history_store_id_reference_idx` (store_id, reference)                     |
| `cart_bundles_cart_id_idx`                         |   8 kB |           13,455 | `cart_bundles_cart_id_bundle_id_key` UNIQUE (cart_id, bundle_id)                     |

392 kB in all, and one less index to maintain on every write to eight tables. The scan counts are
lifetime counters (`pg_stat_database.stats_reset` is NULL). A high count on a redundant index only
means the planner chose the shorter of two equivalent indexes; it is not a reason to keep it.

**Foreign keys.** An FK needs an index leading on its columns for parent-delete probes. The
FK-coverage query from "Re-run", with the eight indexes excluded, returns 0 rows of 205 FKs. Its
positive control (excluding `cart_bundles_cart_id_idx`, `cart_bundles_cart_id_bundle_id_key`,
`carts_store_id_idx` and `carts_store_id_session_id_key` together) flags exactly the two FKs that
lose their index (`carts_store_id_fkey`, `cart_bundles_cart_id_fkey`), so the query can fail.

**Plans.** A fresh scratch PG 16, migrated with `prisma migrate deploy`, seeded with 20 stores and
40k products, 60k carts, 60k orders, 60k payment events, 60k inventory rows, 100k audit rows, 40k
recommendations and 30k cart bundles (`ANALYZE`d, identical data before and after): 17 store-scoped
statements, EXPLAIN (ANALYZE, BUFFERS) before and after, best of 7 runs. Every statement keeps an
index plan; none becomes a sequential scan (`payment_events` by `event_type` alone was already a seq
scan because the column has 6 values). The statements that used a dropped index now use its
covering one:

| Statement                                    | Before                              | After                                                |
| -------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| carts, count by store                        | `carts_store_id_idx`, 0.27 ms       | `carts_store_id_session_id_key`, 0.40 ms             |
| carts, store + `created_at` range (funnel)   | `carts_store_id_idx`, 2.45 ms       | `carts_store_id_session_id_key`, 1.58 ms             |
| audit_logs, count by store                   | `audit_logs_store_id_idx`, 0.39 ms  | `audit_logs_store_id_created_at_idx`, 0.58 ms        |
| payment_events, `event_type` + `occurred_at` | `…event_type_idx`, 1.78 ms          | `payment_events_event_type_occurred_at_idx`, 1.60 ms |
| cart_bundles, by cart / FK probe             | `cart_bundles_cart_id_idx`, 0.05 ms | `cart_bundles_cart_id_bundle_id_key`, 0.04 ms        |
| ai_recommendation, store + source product    | the 3-column unique, 0.05 ms        | the same, 0.04 ms (the planner already preferred it) |
| orders, products, inventory_history          | already on a longer or other index  | unchanged (0.04 to 8 ms, within noise)               |

The cost is real but small: a plain `count(*) WHERE store_id = …` now walks a wider index, so
`carts` and `audit_logs` store counts are 0.1 to 0.2 ms slower at 60k to 100k rows. Single-row
lookups and the FK probe are unchanged. The saving is the write cost and 392 kB.

**Kept: `product_variants_sku_idx` (32 kB, 0 scans).** Not dropped (Ruling DBM-2). It has no longer
index behind it. Zero scans reflect a 353-row table the planner seq-scans, not an absent query:
`stock-adjustments.routes.ts` looks variants up by `sku IN (…)` with no other index on `sku`, and
its sibling `product_variants_product_id_barcode_idx` is also at zero because the barcode and bulk
stock features have not been used yet. Re-check after they have run.

## Recommendations outside this PR

1. ~~Enable `pg_stat_statements` on the production Neon database.~~ Done 2026-10-03 (owner-approved):
   migration `20261003110000_enable_pg_stat_statements`. How to read it: `docs/DB-INDEX-MIGRATIONS.md`.
2. The per-request reads of empty or near-constant tables (`reviews`, `store_faqs`, `store_howtos`,
   `store_pages`, `warehouses`) belong to a caching pass, not an index pass.
3. ~~The order search matches **registered** customers only.~~ Done 2026-10-03 (owner-approved): it
   also matches guest orders by the guest's name, email and phone, which live in `shipping_address`
   (174 of 188 production orders are guests). See "Added — guest contact search" above.

## Re-run

```sql
-- seq-scan pressure
SELECT relname, n_live_tup, seq_scan, seq_tup_read, idx_scan
FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY seq_tup_read DESC LIMIT 20;

-- FKs with no index leading on their columns (expect 0 rows after this PR)
SELECT c.conrelid::regclass, c.conname
FROM pg_constraint c
WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
      AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
      AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey);

-- left-prefix duplicate btrees (slices re-based to 1 so the arrays compare)
WITH ix AS (
  SELECT i.indexrelid, i.indrelid, i.indisunique,
         (i.indkey::int2[])[0:i.indnkeyatts - 1] k, (i.indoption::int2[])[0:i.indnkeyatts - 1] o,
         i.indpred IS NULL AND i.indexprs IS NULL plain, am.amname
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam)
SELECT a.indrelid::regclass, a.indexrelid::regclass redundant, b.indexrelid::regclass covered_by
FROM ix a JOIN ix b ON b.indrelid = a.indrelid AND b.indexrelid <> a.indexrelid
WHERE NOT a.indisunique AND a.plain AND b.plain AND a.amname = 'btree' AND b.amname = 'btree'
  AND cardinality(a.k) < cardinality(b.k)
  AND b.k[1:cardinality(a.k)] = a.k AND b.o[1:cardinality(a.k)] = a.o;
```

Run read-only against `DIRECT_URL` with
`PGOPTIONS='-c default_transaction_read_only=on'`. Pair any add/drop with `EXPLAIN` of the query it
is for. Lock procedure for any index build: [`docs/DB-INDEX-MIGRATIONS.md`](../DB-INDEX-MIGRATIONS.md).
