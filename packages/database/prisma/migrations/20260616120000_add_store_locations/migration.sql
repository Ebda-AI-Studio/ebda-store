-- Per-store physical locations / branches feature.
ALTER TABLE "stores" ADD COLUMN "locations_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "store_locations" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "store_id"       TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "name_ar"        TEXT,
    "country"        TEXT NOT NULL,
    "country_ar"     TEXT,
    "address"        TEXT NOT NULL,
    "address_ar"     TEXT,
    "phone"          TEXT,
    "whatsapp"       TEXT,
    "maps_url"       TEXT,
    "maps_embed_url" TEXT,
    "hours"          TEXT,
    "hours_ar"       TEXT,
    "is_published"   BOOLEAN NOT NULL DEFAULT true,
    "position"       INTEGER NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "store_locations_store_id_fkey"
        FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE
);
CREATE INDEX "store_locations_store_id_is_published_position_idx"
    ON "store_locations"("store_id", "is_published", "position");

ALTER TABLE "store_locations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rls_store_locations_tenant" ON "store_locations"
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
ALTER TABLE "store_locations" FORCE ROW LEVEL SECURITY;
