# FP-8

> Section: Admin fix pass 2026-11-04, track T1 API core (branch `feat/admin-fix-t1-api-core`)

Ruling FP-8 - BE:F-3, `PUT /stores/:id/branding-bundle`. The `/stores` router has no request transaction, so `StoreService.updateBrandingBundle` opens one itself (`runInTenantContext`; every `withStore` and the atomic settings statement inside reuse it) on a Postgres store: a failure in any part (branding, theme, contact, social, settings, blogEnabled) rolls ALL of it back, and the caches are busted after the commit. On a D1 + Durable Object store D1 and the DO cannot share a transaction, so the parts apply in order and a failure leaves the earlier parts written. Every part is an idempotent write, so saving again converges. Evidence: `tests/integration/store-settings-atomic.test.ts` (a failing part leaves the earlier parts unwritten, real Postgres). Cost if wrong: on a DO store a merchant sees one error and finds part of the page saved until they save again.
