# CF-SCHEMA-2

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling CF-SCHEMA-2 (2026-10-24) - the four identity models (User, RefreshToken, VerificationToken, PasskeyCredential) are NOT emitted: they belong to the ebda-identity D1 owned by the identity track (Rulings ID-1, ID-2). The platform D1 therefore has 21 models plus `entity_index` and `platform_audit_log` (23 tables); the StoreDO has 114 models plus `store_profile`, `store_config`, `commerce_outcomes`, `d1_outbox`, `do_flags` (119 tables). Cost if wrong: if identity ends up inside the platform D1, add the four tables by removing them from `identity` in `model-split.json` and regenerating.
