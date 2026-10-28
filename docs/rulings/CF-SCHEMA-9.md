# CF-SCHEMA-9

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling CF-SCHEMA-9 (2026-10-26) - `ProviderVerification` and `ProviderVerificationEvent` (merged to main after the split was written) are platform-wide counters with no store scope, so both go to D1. Current counts, generated: 118 StoreDO tables (113 models + 5 infrastructure) and 25 D1 tables (23 models + entity_index + platform_audit_log); 147 models. The D1 total now equals the plan's 25 by coincidence (23 models, the four identity models excluded, plus two infrastructure tables), not by the plan's own arithmetic. Cost if wrong: provider verification rows would be unreachable from a store-scoped DO; they are read by super-admin and settlement paths across stores.
