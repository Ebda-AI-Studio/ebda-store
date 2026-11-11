-- Hand-written (Ruling SKIN-DEL-10, expand step). The StoreDO twin of platform/0011: drop the triggers store/0004 added, so a
-- DO never rejects a retired template its running release (or, after a rollback, the previous one) writes. Readers map any
-- stored value (`normalizeLegacyTemplate`). The triggers return as migrations-pending/store/0007_template_current_contract.sql,
-- one release after the code stops writing retired values (gate in docs/rulings/SKIN-DEL-10.md). `store_profile` keeps no
-- original: 0004 kept none and DO stores are pre-launch. Idempotent; the StoreDO records it as cf-0006_template_expand_only.
DROP TRIGGER IF EXISTS "store_profile_template_current_insert";
DROP TRIGGER IF EXISTS "store_profile_template_current_update";
