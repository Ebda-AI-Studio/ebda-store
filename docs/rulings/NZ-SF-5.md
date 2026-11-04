# NZ-SF-5

> Section: NEON-ZERO storefront + cart (2026-11-04)

**Ruling NZ-SF-5 - a shopper's addresses live in the customer's StoreDO, and the `/addresses` routes resolve their store from the
request.** `Address` is `store-do` in `model-split.json` and customer accounts are per store in the DO, but the routes had no store
(a bare mount, `userContext` with none), so every address call opened a Postgres user transaction and 500ed with Postgres
unreachable. The store is the `X-Store-ID` header (the web client sends it on every request) or the store the customer token is
bound to; `authenticate` already refuses a header store that differs from the token's (`customer-store-binding`), and a customer
with neither gets 400 `STORE_REQUIRED`. Reads and writes go through `storeWriter` (`Address` joins `DO_WRITABLE_MODELS`); a
Postgres store keeps `prisma` behind the same call, a merchant/admin token with no store keeps its Postgres address book, and the
`userContext` fork (NZ-SF-1) opens no Postgres transaction for a DO store. The user-data export reads a DO store's addresses from
its DO. Evidence: `apps/api/workers-test/route-sweep.test.ts` (the five `/addresses` routes with Postgres dead),
`tests/unit/do-writable-direct-readers.test.ts`. Cost if wrong: a shopper's addresses are per store, not shared across Ebda stores
(intended, it matches the per-store accounts); addresses saved in Postgres for a store that is already on its DO are not visible
there until the store's copy carries them.
