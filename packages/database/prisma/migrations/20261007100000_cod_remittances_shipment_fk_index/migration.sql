-- cod_remittances.shipment_id is a foreign key (ON DELETE SET NULL -> shipments) whose only
-- indexes lead on store_id, so deleting/updating a shipment seq-scanned cod_remittances.
-- tests/integration/db-maintenance-indexes.test.ts ("every foreign key still has an index
-- leading on its columns") caught it. The (store_id, shipment_id) index stays: tenant-scoped
-- reads use it.
CREATE INDEX IF NOT EXISTS "cod_remittances_shipment_id_idx" ON "cod_remittances"("shipment_id");
