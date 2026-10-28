# PROVIDERS-4

> Section: 2026-10-07 — Provider catalog, Batch 0 + payments Batch 1 (PROVIDERS-\*)

Ruling PROVIDERS-4 — single writer for gateway keys: on the STORE routes, credentials are written only by `PUT /payment-settings/store/:storeId/:provider/credentials`; the generic store create/update routes answer 422 `USE_CREDENTIALS_ENDPOINT` for `apiKey|secretKey|merchantId|webhookSecret` of a non-manual provider. The super-admin GLOBAL routes (`storeId` NULL rows, unreachable to `ebda_app` under strict RLS) were left on the legacy columns. Cost if wrong: a script that wrote store keys through the generic route now gets 422.
