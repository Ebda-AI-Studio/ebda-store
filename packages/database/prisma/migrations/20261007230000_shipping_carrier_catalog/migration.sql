-- Provider catalog, shipping batch (EXPAND). Rulings PROVIDERS-1 / PROVIDERS-2 / PROVIDERS-7 /
-- PROVIDERS-9 (2026-10-07), plan docs/plans/2026-10-07-egypt-payments-shipping-integrations.md.
--
--   shipping_carrier_configs.test_mode          NEW. Active mode of the stored credentials. FALSE for
--                                               every existing row: before this migration a row held
--                                               ONE flat credential set, read as live (a row whose
--                                               settings said `sandbox: true` is set TRUE below, so
--                                               the same set stays the active one).
--   shipping_carrier_configs.credential_hints   NEW. Non-secret display data per mode and field.
--   shipping_carrier_configs.connection_test    NEW. Last Test connection {ok, code, mode, at,
--                                               fingerprint}; enabling needs ok for the CURRENT
--                                               credentials. Existing enabled rows have none, so they
--                                               are disabled below until their owner tests them.
--
-- `credentials` keeps its column and its type: it now holds {"sandbox": {...}, "live": {...},
-- "webhookSecret": "..."} instead of a flat map. Flat ciphertext cannot be rewritten in SQL, so the
-- reader (apps/api carriers/carrier-credentials.ts) accepts the old shape and the next save writes
-- the new one. Nothing is dropped here; there is no contract step for credentials.
--
-- iCarry (the inherited carrier, ruling PROVIDERS-7) is removed from the product: its configs are
-- deleted (they could never be used again); its shipments are KEPT as manual shipments named
-- "iCarry" (tracking number, history and COD facts stay; the merchant moves them along by hand), and
-- its COD remittance lines follow them so reconciliation still matches.
--
-- These three tables are FORCE row-level-secured, which binds even the owner, so the data steps run
-- with FORCE lifted for this transaction only (restored right after).
--
-- Rollback (docs/ROLLBACK.md): drop the three columns. The deleted iCarry configs and the
-- iCarry -> manual relabel are not reversible (the pre-migration Neon PITR window is the way back).

ALTER TABLE "shipping_carrier_configs" ADD COLUMN "test_mode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "shipping_carrier_configs" ADD COLUMN "credential_hints" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "shipping_carrier_configs" ADD COLUMN "connection_test" JSONB;

ALTER TABLE "shipping_carrier_configs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "shipments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "cod_remittances" NO FORCE ROW LEVEL SECURITY;

DELETE FROM "shipping_carrier_configs" WHERE "carrier" = 'icarry';

UPDATE "shipping_carrier_configs"
   SET "test_mode" = true
 WHERE "settings" ->> 'sandbox' = 'true';

-- Untested credentials cannot stay enabled (the gate now requires a current Test connection).
UPDATE "shipping_carrier_configs" SET "enabled" = false, "is_default" = false WHERE "enabled" = true;

UPDATE "shipments"
   SET "carrier_name" = COALESCE("carrier_name", 'iCarry'), "carrier" = 'manual'
 WHERE "carrier" = 'icarry';

-- (store, carrier, line_ref) is unique: a line that would collide with an existing manual line is
-- the same statement line imported twice, so the iCarry copy is dropped.
DELETE FROM "cod_remittances" r
 WHERE r."carrier" = 'icarry'
   AND EXISTS (SELECT 1 FROM "cod_remittances" m
                WHERE m."store_id" = r."store_id" AND m."carrier" = 'manual' AND m."line_ref" = r."line_ref");
UPDATE "cod_remittances" SET "carrier" = 'manual' WHERE "carrier" = 'icarry';

ALTER TABLE "shipping_carrier_configs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "shipments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cod_remittances" FORCE ROW LEVEL SECURITY;
