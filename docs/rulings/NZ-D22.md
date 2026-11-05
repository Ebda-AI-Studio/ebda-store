# NZ-D22

> Section: NEON store create on D1 / DO (2026-11-04)

**Ruling NZ-D22 - a new store is created on D1 + its Durable Object with NO Postgres row, behind
`STORE_CREATE_ON_DO` (default off until N-6 and N-10), and `syncStoreFields` is deleted.** N-18:
`StoreService.create`, `ProvisioningService.provisionStore` and (through them) self-serve onboarding call
`lib/store-create-do.ts` when `STORE_CREATE_ON_DO=1` and both `PLATFORM_DB` and `STORE_DO` are bound: (1) the D1
`stores` row is inserted with `storage_backend='do'` (its unique slug / domain indexes refuse a taken address first,
409), (2) `StoreDO.bootstrapStore` writes `store_profile`, `store_config`, the INACTIVE default VAT rate (rate in
hundredths of a percent: 1400) and, for provisioning, the enabled COD config (idempotent: a retry converges), (3) the
subscription and the signup trial are written by the existing `syncSubscriptionFromLegacyPlan` / `startSignupTrial`
against the platform D1 client (`writeNewStoreSubscription`, the ONE place N-10 swaps), (4) the chart of accounts is
seeded by the existing DO path, then the directory cache is cleared. A failure in 2 deletes the D1 row again; a failure in
3 or 4 deletes it too (slug freed; the DO keeps only its bootstrap rows and its random id is never reused). The owned-
store reads (`assertOwnerMayCreateStore`, the self-serve limit and the daily cap, the first-store test) read the D1
directory where `PLATFORM_DB` is bound (it holds every store: Postgres stores are mirrored there). `getEntitlements`
falls back to D1 (store, subscription, plan) only when Postgres has no row for the store. N-23/NZ-D14: `StoreService.delete`
probes Postgres once; a store with no Postgres row skips its Postgres phase (reads and the family check come from D1 /
the DO) and keeps the DO close, the integrator clients and `finishStoreDeletion`. N-19: the four
`syncStoreFields(storeId, ['settings'])` call sites (`updateQrSettings` and `updateLabelSettings` now go through
`setSettingsKey`; the two atomic helpers and the two setup-guide writers) no longer re-read: a Postgres store keeps
#400's single atomic statement and copies the `RETURNING` whole value with `copyStoreSettings`; a D1 + DO store never runs
raw SQL and read-merges, then `storeUpdate`s the whole `settings` value. Evidence: `tests/unit/store-create-do.test.ts`,
`store-service-do-native.test.ts`, `setup-guide-write.test.ts` (Postgres poisoned), `workers-do/mutate.test.ts`
(bootstrap on real workerd), `workers-test/pg-unreachable.test.ts` (a store created with Postgres at a dead port:
D1 row `do`, subscription in D1, DO bootstrapped). `git grep syncStoreFields apps/api/src` is empty. NOT verifiable
today, by design of the other tracks: storefront home, PDP, add to cart and login still answer 500 with Postgres dead
for ANY store (N-2, N-3, N-4, N-9), so the test asserts the created store behaves exactly like an already-flagged DO
store. Residuals: (a) the default is OFF because store-access (`readStoreForAccess`) and the billing readers still read
Postgres, so a store with no Postgres row cannot be administered until N-6 / N-10; (b) the owner row is identity and
`create` returns `owner: { id }` only; provisioning still find-or-creates the owner in Postgres; (c) `assertPlanAllows`
(domain at creation, super-admin only), `loadPayablePlan` and the second-store gate's `getEntitlements(oldest store)` read
Postgres first; (d) D1 `plans` must hold the plan rows (the subscription FK): imported with the platform data, NOT
checked against production (no production SQL was run); (e) a read-merge on a DO store can lose one key to a writer in the
same few milliseconds (the #400 residual, unchanged). Cost if wrong: turning the flag on early creates stores whose admin
returns 404 STORE_NOT_FOUND until N-6 lands; a missing D1 plan row fails the create (503, the D1 row is removed again).

**Amendment 2026-11-04 (Opus review of #408, six findings fixed).** (1) The D1 owner-store reads are gated on
`storeCreateOnDo()`: flag OFF = Postgres only (the unchanged behaviour); flag ON = the UNION by id (lists) / the MAX (counts) of
Postgres and D1, an unreachable Postgres counting as "no Postgres stores", so a store whose directory mirror failed is still
counted (no second Growth trial, no plan-gate bypass). (2) The D1 + DO provisioning path keeps the owner's
`ensureAdminUser` in a Postgres transaction that stays open until the store exists, so a failed create leaves no owner row (a
retry gets its temporary password); a failed COMMIT after the store exists rolls the store back. (3) The store row and its
subscription / trial row are ONE atomic D1 batch BEFORE the DO bootstrap; a rollback that itself fails is a P1 alert
(`store.create.do_rollback_failed`) plus an error log. A reconciler sweep of "`do` rows with no subscription" is NOT added:
stores migrated from Postgres are `do` rows whose subscription is still in Postgres, so it would delete real stores; N-10
adds it once subscriptions are in D1. (4) Only `UNIQUE constraint failed` is a taken address, and it answers `SLUG_TAKEN` on
both create paths; NOT NULL / CHECK failures are a 503. (5) The whole-value copy of a raw settings write carries the row's
`updated_at`; the DO ignores a copy older than the one it holds (`applyStoreSettings`). (6) `getEntitlements` called with
`known` now also looks for the subscription in D1 when Postgres has none (inline; PR #407's module is not on main, replace the
read when it lands). (d) The plan gate is enforced atomically in the D1 insert (`INSERT ... WHERE count < allowance`, an
account's allowance from `ownerStoreAllowance`), so it fails CLOSED, unlike the Redis creation lock; the allowance count is
D1-only, and the Postgres-aware pre-check (`assertOwnerMayCreateStore`) still runs first. Cost if wrong: an owner whose
Postgres store never reached the D1 directory could exceed the allowance by that one store in the narrow race between the
pre-check and the insert.
