-- Product facts: ordered { key, keyAr, value, valueAr, onCard }[] shown as a PDP table, card chips and compare rows.
ALTER TABLE "products" ADD COLUMN "facts" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "products" ADD CONSTRAINT "products_facts_is_array" CHECK (jsonb_typeof("facts") = 'array');
