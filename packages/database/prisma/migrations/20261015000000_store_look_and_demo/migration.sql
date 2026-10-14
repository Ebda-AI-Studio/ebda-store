-- 20261015000000_store_look_and_demo: additive (Rulings LOOKS-2, LOOKS-4).
-- Both columns are new and nullable / defaulted, so this is safe on a live DB and
-- needs no backfill. `stores` is already under strict RLS (store-scoped policy);
-- new columns need no policy change. No SECURITY DEFINER function projects store
-- identity columns (ebda_resolve_store_id returns the id only), so none is redefined.
ALTER TABLE "stores" ADD COLUMN "look" TEXT;
ALTER TABLE "stores" ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;
-- Look ids are validated in the API against the shared registry; the CHECK is format only.
ALTER TABLE "stores" ADD CONSTRAINT "stores_look_format" CHECK ("look" IS NULL OR "look" ~ '^(qamar|souq|jasmine|lamma|dahab)\.[a-z]+$');
