# R-EBDA-007

> Section: 2026-10-07 — Tenant defence: code-level guard + RLS on everything (R-EBDA-003..008)

Ruling R-EBDA-007 — platform-level ("global", `store_id NULL`) payment configs are retired. Strict RLS already hid those rows from `ebda_app` and rejected writes, so the super-admin `/payment-settings` global routes could only list nothing and fail, and the checkout's "fall back to the global config" reads could only return nothing. The global routes now answer 410 `GLOBAL_PAYMENT_CONFIG_UNSUPPORTED` behind the same authentication; the checkout and COD reads take only the store's own rows; the per-store response keeps `globalConfigs: []` so its shape does not change. Evidence: `tests/unit/payment-settings-routes.test.ts`. Cost if wrong: if Ebda ever wants a platform-default gateway it needs a definer or a new design, not these routes.
