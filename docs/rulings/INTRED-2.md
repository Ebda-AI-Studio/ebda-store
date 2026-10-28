# INTRED-2

> Section: Main integration lane red (2026-10-22, branch `fix/main-integration-red`)

- Ruling INTRED-2 - tests that mount a router directly mount the same context middleware `routes/index.ts` does (`tenantContext`, `orderRouteContext`, `publicStoreContext`), and calls to a scoped service run inside `runInTenantContext`. Changed: `b2b-storefront-visibility` (direct service calls), `optional-bool-query-featured`, `report-filters-apply`. Assertions unchanged. Cost if wrong: a bare mount would again hide a missing context; the production mount is exercised by `self-serve-onboarding-live` and the ebda_app suites.
