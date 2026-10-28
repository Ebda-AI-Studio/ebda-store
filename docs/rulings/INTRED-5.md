# INTRED-5

> Section: Main integration lane red (2026-10-22, branch `fix/main-integration-red`)

- Ruling INTRED-5 - real defect, fixed with a migration: four composite ownership FKs had no leading index (`webhook_deliveries (endpoint_id, store_id)`, `product_price_tiers (product_id, variant_id)` and `(store_id, group_id)`, `wholesale_applications (store_id, group_id)`); `20261101000100_fk_leading_indexes_webhooks_b2b` adds them (plain `CREATE INDEX IF NOT EXISTS`, pre-launch tables), schema.prisma updated. Cost if wrong: four more indexes on write paths of small tables.
