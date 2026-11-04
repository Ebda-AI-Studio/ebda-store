# NZ-SF-4

> Section: NEON-ZERO storefront + cart (2026-11-04)

**Ruling NZ-SF-4 - `Wishlist`, `WishlistItem`, `Bundle` and `BundleItem` join `DO_WRITABLE_MODELS` / `WritableModel`, and a bundle
write on a DO store is one atomic batch, not a nested relation write.** The storefront wishlist (`wishlist.routes`) and the
merchant bundle CRUD (`bundle.routes`) wrote Postgres only. Both now go through `storeWriter` (the wishlist by the `x-store-id`
header; the two delete routes the storefront can call without it stay on Postgres, the known gap already documented there) and
`storeDb` for reads. A Durable Object refuses nested relation writes, so on a DO store bundle create is
`$transaction([bundle.create, bundleItem.createMany])` with a client-generated id and update is
`[bundleItem.deleteMany, bundle.update, bundleItem.createMany]` (the wipe and the rewrite still fail together); a Postgres store
keeps its nested `items: { create | deleteMany }` inside the request transaction, unchanged. `verify-payment` reads its order from the
store backend; the confirmation write (`confirmPaymentFromProviderStatus`) is a money path on Postgres and stays with N-11 / N-12.
`tests/unit/fixtures/do-writable-direct-readers.json` records the remaining direct readers of the four models (all behind a
Postgres-branch early return or a caller-supplied client). Evidence: `apps/api/workers-test/pg-unreachable.test.ts` (public bundle
list, wishlist add + read, verify-payment 404 from the DO, Postgres at a dead port),
`tests/unit/do-writable-direct-readers.test.ts`. Cost if wrong: the bundle admin CRUD on a DO store has no workers-test case yet
(its `requireStoreAccess` still reads Postgres until N-6), so a defect in the batch shape would show first in a merchant's editor.
