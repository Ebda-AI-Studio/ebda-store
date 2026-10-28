# EBDA-DEPLOY-2

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling EBDA-DEPLOY-2 — production web deploys with `OPENNEXT_CACHE=true` (R2 incremental cache + DO tag cache + DO queue), the same config `ci.yml`'s worker-dry-run already builds, on the EXISTING bucket `ebda-web-isr-cache` (the generator named a never-created `ebda-web-opennext-cache`). Evidence: `wrangler deploy` of ebda-web 2026-10-07 bound NEXT_TAG_CACHE_DO_SHARDED, NEXT_CACHE_DO_QUEUE and NEXT_INC_CACHE_R2_BUCKET (ebda-web-isr-cache). Cost if wrong: a DO/tag-cache defect surfaces in the storefront rather than in a preview; rollback is `wrangler rollback` on ebda-web.
