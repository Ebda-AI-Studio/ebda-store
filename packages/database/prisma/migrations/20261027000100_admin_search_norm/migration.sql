-- Admin customer/order search (search program P2, Task 15): Arabic-normalised names and digit-only
-- phones, so "احمد" finds "أحمد" and "0101 234 5678" / "+20101…" / "٠١٠…" find the same customer.
-- public.ebda_digits is IMMUTABLE and schema-qualified (pg_restore runs with an empty search_path
-- and must be able to rebuild the indexes). The four indexes are expression trigram indexes; the
-- store-scoped SECURITY DEFINER lookup of 20261027000200 is what lets ebda_app use them (RLS makes
-- an inline predicate unable to; Ruling SEARCH-T14-1).
-- Index build time (measured, 100k-order scratch DB, local): see docs/DB-INDEX-MIGRATIONS.md.
-- PRODUCTION PREREQUISITE (STOP-5): `users` and `orders` are live tables. Post-launch, pre-build all
-- four indexes with CREATE INDEX CONCURRENTLY IF NOT EXISTS on DIRECT_URL (autocommit, outside peak
-- hours) and confirm no INVALID index before merge; this file is then a no-op there. Pre-launch the
-- tables are empty and the pre-build is waived (Ruling SEARCH-16).
-- Rollback: rollback.sql (roll the CODE back first).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION public.ebda_digits(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(translate(t, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g')
$$;

CREATE INDEX IF NOT EXISTS "users_phone_digits_trgm_idx" ON "users" USING gin
  (public.ebda_digits("phone") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_name_norm_trgm_idx" ON "users" USING gin
  (public.ebda_ar_norm(coalesce("first_name", '') || ' ' || coalesce("last_name", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "orders_guest_phone_digits_trgm_idx" ON "orders" USING gin
  (public.ebda_digits("shipping_address" ->> 'phone') gin_trgm_ops) WHERE "customer_id" IS NULL;
CREATE INDEX IF NOT EXISTS "orders_guest_name_norm_trgm_idx" ON "orders" USING gin
  (public.ebda_ar_norm(coalesce("shipping_address" ->> 'firstName', '') || ' ' || coalesce("shipping_address" ->> 'lastName', '')) gin_trgm_ops)
  WHERE "customer_id" IS NULL;
