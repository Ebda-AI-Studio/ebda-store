-- Add single-column indexes for foreign-key columns that lacked one.
-- Postgres does NOT auto-index FK columns; without these, JOINs on
-- the FK and parent-row deletes (cascade lookups) do sequential scans.
-- All statements use CREATE INDEX IF NOT EXISTS so this migration is
-- idempotent and safe to re-run.

-- product_tags
CREATE INDEX IF NOT EXISTS "product_tags_tag_id_idx" ON "product_tags"("tag_id");

-- cart_items
CREATE INDEX IF NOT EXISTS "cart_items_variant_id_idx" ON "cart_items"("variant_id");

-- order_items
CREATE INDEX IF NOT EXISTS "order_items_variant_id_idx" ON "order_items"("variant_id");

-- product_variant_options
CREATE INDEX IF NOT EXISTS "product_variant_options_value_id_idx" ON "product_variant_options"("value_id");

-- wishlist_items
CREATE INDEX IF NOT EXISTS "wishlist_items_product_id_idx" ON "wishlist_items"("product_id");

-- reviews
CREATE INDEX IF NOT EXISTS "reviews_customer_id_idx" ON "reviews"("customer_id");

-- return_items
CREATE INDEX IF NOT EXISTS "return_items_order_item_id_idx" ON "return_items"("order_item_id");

-- store_features
CREATE INDEX IF NOT EXISTS "store_features_enabled_by_idx" ON "store_features"("enabled_by");

-- abandoned_carts
CREATE INDEX IF NOT EXISTS "abandoned_carts_customer_id_idx" ON "abandoned_carts"("customer_id");
CREATE INDEX IF NOT EXISTS "abandoned_carts_coupon_id_idx" ON "abandoned_carts"("coupon_id");

-- product_relations
CREATE INDEX IF NOT EXISTS "product_relations_source_product_id_idx" ON "product_relations"("source_product_id");
CREATE INDEX IF NOT EXISTS "product_relations_target_product_id_idx" ON "product_relations"("target_product_id");

-- frequently_bought_together
CREATE INDEX IF NOT EXISTS "frequently_bought_together_product_id_2_idx" ON "frequently_bought_together"("product_id_2");
CREATE INDEX IF NOT EXISTS "frequently_bought_together_product_id_1_idx" ON "frequently_bought_together"("product_id_1");

-- accounts
CREATE INDEX IF NOT EXISTS "accounts_parent_id_idx" ON "accounts"("parent_id");

-- ai_recommendation
CREATE INDEX IF NOT EXISTS "ai_recommendation_target_product_id_idx" ON "ai_recommendation"("target_product_id");
CREATE INDEX IF NOT EXISTS "ai_recommendation_source_product_id_idx" ON "ai_recommendation"("source_product_id");

-- purchase_orders
CREATE INDEX IF NOT EXISTS "purchase_orders_ap_account_id_idx" ON "purchase_orders"("ap_account_id");

-- purchase_order_items
CREATE INDEX IF NOT EXISTS "purchase_order_items_variant_id_idx" ON "purchase_order_items"("variant_id");

-- stock_adjustment_items
CREATE INDEX IF NOT EXISTS "stock_adjustment_items_variant_id_idx" ON "stock_adjustment_items"("variant_id");

-- reorder_rules
CREATE INDEX IF NOT EXISTS "reorder_rules_product_id_idx" ON "reorder_rules"("product_id");
CREATE INDEX IF NOT EXISTS "reorder_rules_variant_id_idx" ON "reorder_rules"("variant_id");
CREATE INDEX IF NOT EXISTS "reorder_rules_preferred_supplier_id_idx" ON "reorder_rules"("preferred_supplier_id");

-- backorder_lines
CREATE INDEX IF NOT EXISTS "backorder_lines_variant_id_idx" ON "backorder_lines"("variant_id");
CREATE INDEX IF NOT EXISTS "backorder_lines_fulfilled_by_po_item_id_idx" ON "backorder_lines"("fulfilled_by_po_item_id");

-- expenses
CREATE INDEX IF NOT EXISTS "expenses_paid_from_account_id_idx" ON "expenses"("paid_from_account_id");
CREATE INDEX IF NOT EXISTS "expenses_expense_account_id_idx" ON "expenses"("expense_account_id");
CREATE INDEX IF NOT EXISTS "expenses_supplier_id_idx" ON "expenses"("supplier_id");

-- reorder_suggestions
CREATE INDEX IF NOT EXISTS "reorder_suggestions_product_id_idx" ON "reorder_suggestions"("product_id");
CREATE INDEX IF NOT EXISTS "reorder_suggestions_variant_id_idx" ON "reorder_suggestions"("variant_id");
CREATE INDEX IF NOT EXISTS "reorder_suggestions_supplier_id_idx" ON "reorder_suggestions"("supplier_id");

-- deadstock_flags
CREATE INDEX IF NOT EXISTS "deadstock_flags_product_id_idx" ON "deadstock_flags"("product_id");
CREATE INDEX IF NOT EXISTS "deadstock_flags_variant_id_idx" ON "deadstock_flags"("variant_id");

-- payment_events
CREATE INDEX IF NOT EXISTS "payment_events_triggered_by_user_id_idx" ON "payment_events"("triggered_by_user_id");

-- affiliate_events
CREATE INDEX IF NOT EXISTS "affiliate_events_triggered_by_user_id_idx" ON "affiliate_events"("triggered_by_user_id");

-- count_lines
CREATE INDEX IF NOT EXISTS "count_lines_product_id_idx" ON "count_lines"("product_id");
CREATE INDEX IF NOT EXISTS "count_lines_variant_id_idx" ON "count_lines"("variant_id");

-- bank_statements
CREATE INDEX IF NOT EXISTS "bank_statements_gl_account_id_idx" ON "bank_statements"("gl_account_id");

-- bank_transactions
CREATE INDEX IF NOT EXISTS "bank_transactions_matched_journal_entry_id_idx" ON "bank_transactions"("matched_journal_entry_id");
