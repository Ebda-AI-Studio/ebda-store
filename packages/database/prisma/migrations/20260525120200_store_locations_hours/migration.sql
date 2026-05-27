-- Store: business_hours + google_maps_url for WhatsApp bot "Locations & Hours" branch
-- Phase D.6 — used by routeLocations() in WBS wa-ordering.js (Wave 2A).
-- Both columns are nullable (no default, no existing data affected).

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "business_hours"  TEXT,
  ADD COLUMN IF NOT EXISTS "google_maps_url" TEXT;
