# NZ-SF-2

> Section: NEON-ZERO storefront + cart (2026-11-04)

**Ruling NZ-SF-2 - with the platform D1 bound, `backendFor` answers 404 `STORE_NOT_FOUND` for an id the directory does not
hold (N-14); the host resolver of the public request reads the same directory.** The directory holds every store (Postgres stores
are mirrored by the N-22 dual-write and the hourly reconciler, a DO-native store exists only there), so "no row" never means
"Postgres": it means the store does not exist, and a default of `pg` would send a missing store's cart and checkout to a database
that is about to be removed. The webhook resolver treats that 404 as "not routable" (it was a `pg` answer that skipped the row).
`resolveStoreId` (host -> store for `X-Store-ID` / `x-store-domain`, called by `publicStoreContext`) used the Postgres definer
`ebda_resolve_store_id`; with D1 bound it now reads the directory (`status = 'active'`, verified domain, not deleted), like
`lookupStore`. `backendFor` stays temporary (N-14b). Evidence: `tests/unit/store-backend-flag.test.ts`,
`tests/unit/webhook-do-resolver.test.ts`, `tests/unit/platform-directory-d1.test.ts`. Cost if wrong: a Postgres store whose
directory row was never mirrored is unreachable for carts and checkout (404) until the reconciler repairs it; the N-22 mirror and
reconciler exist to keep that window empty.
