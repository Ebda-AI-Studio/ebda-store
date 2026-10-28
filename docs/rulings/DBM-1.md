# DBM-1

> Section: 2026-10-03 — DB maintenance (pg_stat_statements + redundant prefix indexes)

**Ruling DBM-1 — eight redundant prefix indexes are dropped; each drop is guarded by its covering
index.** `carts_store_id_idx`, `ai_recommendation_store_id_source_product_id_idx`,
`audit_logs_store_id_idx`, `orders_store_id_idx`, `products_store_id_idx`,
`payment_events_event_type_idx`, `inventory_history_store_id_idx`, `cart_bundles_cart_id_idx`. Each
is a strict left prefix of a valid longer btree, backs no constraint, and leaves all 205 FKs indexed
(read-only against production, 2026-10-03; table in `docs/perf/index-audit-2026-10.md`). This
supersedes the "listed, not dropped" part of IDX-3. The migration drops an index only when its
covering index exists and is valid in that database, and the matching `@@index` lines leave
`schema.prisma`. Plain `DROP INDEX`, no `lock_timeout` (a timeout would record the migration FAILED
and block later deploys). Cost if wrong: if a statement turns out to need the short index's smaller
size, it reads a longer index (a few extra pages); `rollback.sql` recreates all eight in one run.
