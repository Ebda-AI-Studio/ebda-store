# Index Audit — 2026-05-01

Source: `pg_stat_user_indexes` + `EXPLAIN (ANALYZE, BUFFERS)` against production Neon.

## Top-used indexes (pulling weight)

| Scans | Index                             | Table           |
| ----: | --------------------------------- | --------------- |
|   472 | `products_store_id_status_idx`    | products        |
|   394 | `store_features_store_id_idx`     | store_features  |
|   391 | `stores_created_at_idx`           | stores          |
|   378 | `reviews_store_id_product_id_idx` | reviews         |
|   360 | `products_featured_idx`           | products        |
|   271 | `stores_domain_key`               | stores          |
|   240 | `order_items_order_id_idx`        | order_items     |
|   237 | `payment_configs_store_id_idx`    | payment_configs |

## Findings

### 1. Missing covering index — products list (storefront hot path)

Query: `WHERE store_id=? AND status='active' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 12`.

Plan today picks `products_store_id_idx`, fetches 264 rows, filters in memory to 231, top-N sorts to 12. ~16ms execution at 287 rows; not a problem yet but the plan never gets better as we grow — sort cost climbs linearly.

**Add:** `products(store_id, deleted_at, created_at DESC)` so the query becomes an index-ordered scan with no in-memory sort.

### 2. Orders list falls back to seq scan

Plan: `Seq Scan on orders Filter: store_id = ?`. Currently fine (21 rows, planner correctly picks seq scan over index for tiny tables) but **no usable index exists for the storeId+createdAt-DESC pattern**. Once orders grow past ~100 rows the planner will flip to a slow path.

**Add:** `orders(store_id, created_at DESC)`.

### 3. Audit-log store-scoped reads

Admin "audit logs for this store" queries hit `audit_logs WHERE store_id=? ORDER BY created_at DESC`. There's a `created_at` index and a `store_id` filter but no composite. With our retention plan dropping rows >90 days, the table caps at maybe 100k rows — composite is cheap insurance.

**Add:** `audit_logs(store_id, created_at DESC)`.

### 4. Order item back-references — already covered

Variant / product detail flows occasionally query "how many orders contain this product." That hits `order_items WHERE product_id = ?`. Verified `order_items_product_id_idx` already exists (added in `20250225000000_add_missing_models`) and is being used. No new index needed; flagged here so the next auditor doesn't re-add it.

## Findings — not actioned (yet)

### Unused indexes (0 scans, ~16-48 KB each)

```
audit_logs_resource_type_idx, stores_status_idx, categories_is_active_idx,
products_status_idx, users_status_idx, stores_plan_idx, carts_updated_at_idx,
cart_items_product_id_idx
```

These take a few hundred KB total and slow inserts a fraction. **Skipping drops for now** — drops are reversible only via re-create which costs lock time at scale. Re-audit when tables grow 10× and decide based on then-current usage.

## Migration

`packages/database/prisma/migrations/20260501030000_perf_indexes` adds three new indexes (#1, #2, #3 above). Plain `CREATE INDEX` (not `CONCURRENTLY`) since current table sizes are tiny — locks complete in <100ms. Re-run this audit pre-large-table-creation if we get to multi-million-row scale.

## Re-run command

Connect to the production DB (`railway connect postgres` from `apps/api/`) and run:

```sql
SELECT relname AS table, indexrelname AS index, idx_scan AS scans
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan DESC LIMIT 30;
```

Pair with `EXPLAIN (ANALYZE, BUFFERS)` on the suspect query to confirm before adding/dropping.
