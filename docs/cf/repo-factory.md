# Repo factory: reads and non-money writes on the store's backend (INFRA-CF-1 PR C + D1 + D1c + D2a + D2b, Rulings CF-REPO-1, CF-WRITES-1..3, CF-STOCK-1, CF-MONEY-1, WAREHOUSE-NEG-1, CF-ERASE-3)

Code: `apps/api/src/lib/repo-factory.ts` (factory + request scope), `packages/repo/src/rpc/*` (wire codec, read executor, write executor `writes.ts`, Worker-side client), `apps/api/src/cf/store-do/store-do.ts` (`query()`), `lib/store-backend.ts` (`backendFor`, the flag). Contract tests: `tests/integration/repo-factory-contract.test.ts` (reads) and `tests/integration/repo-factory-writes-contract.test.ts` (writes): Postgres vs the Durable Object schema, `tests/unit/repo-factory.test.ts`, `apps/api/workers-do/store-do-schema.test.ts` (real workerd).

## How a service asks for its store's data

```ts
const db = await storeDb(storeId); // pg `prisma` by default; the store's Durable Object when its flag says 'do'
const rows = await db.blogPost.findMany({ where: { storeId, isPublished: true } });
```

- Postgres is the default for every store, and then `db` IS the `prisma` proxy: the request transaction, tenant guard and RLS settings are unchanged. With every flag at `pg` a moved service behaves exactly as before.
- `StoreReads` (the type of `db`) offers only `findMany/findFirst/findUnique/findFirstOrThrow/findUniqueOrThrow/count` per model, so code that compiles against it cannot write, run raw SQL, aggregate or open an interactive transaction on either backend. `$transaction([reads...])` exists on the DO client only (one round trip).
- An empty/unresolved store id is a 404 (`STORE_NOT_FOUND`); an unbound Durable Object is a 503; neither falls back to Postgres or "the first store".
- `app.use(repoScope)` (app.ts) opens one scope per request, so the flag is read at most once per (request, store). That memo is NEVER-stale data cached for one request (window = the request); there is no cross-request cache and nothing for the flag writer to invalidate. Outside a request (job, cron, script) each call reads the flag.
- Isolation: the client is per store id and the DO refuses any other store (`STORE_MISMATCH`); the contract test proves store A's DO never returns store B's rows.

## Reads moved in PR C

| Service method                                       | Models                   | Route                             |
| ---------------------------------------------------- | ------------------------ | --------------------------------- |
| `SizeChartService.listPublic`                        | SizeChart                | `GET /public/size-charts`         |
| `BlogService.listPublished`, `getPublishedBySlug`    | BlogPost                 | public blog                       |
| `PagesService.list`, `get`, `getPublic`              | StorePage                | pages (admin + public)            |
| `LocationsService.list`, `listPublished`             | StoreLocation            | locations (admin + public footer) |
| `ProductService.getPublicTags`, `getPublicTagByName` | Tag, ProductTag, Product | `GET /public/tags`                |

To move another read: change `prisma.x.findMany(...)` to `(await storeDb(storeId)).x.findMany(...)`, add the call to the contract test (it fails on any fidelity gap, as it did for `orderBy: { rel: { _count } }`, fixed in prisma-lite in this PR), and keep the call inside the supported surface (INFRA-CF-4 "NOT yet" list).

## Writes moved in PR D1 (`storeWriter`)

```ts
const w = await storeWriter(storeId); // pg `prisma` by default; the store's Durable Object when its flag says 'do'
await w.blogPost.create({ data: { storeId, slug, title, content } });
await w.$transaction(
  orderedIds.map((id, i) =>
    w.category.updateMany({ where: { id, storeId }, data: { position: i } })
  ),
  { idempotencyKey }
);
```

- On `pg` the writer IS the `prisma` proxy (the `$transaction` options argument is dropped), so the request transaction, tenant guard and RLS are unchanged and a moved service behaves exactly as before. On `do` each call is ONE `StoreDO.mutate` RPC = one atomic transaction; `$transaction([...])` ships the whole array as one atomic batch. The read client `storeDb` still has no write delegate at all.
- The DO accepts writes only for `DO_WRITABLE_MODELS` (`packages/repo/src/rpc/writes.ts`, equal to the `WritableModel` type; pinned by a unit test): Product, ProductVariant, ProductOption, ProductOptionValue, ProductVariantOption, ProductImage, ProductCategory, ProductFaq, ProductRelation, ProductPriceTier, ProductTag, Tag, Category, BlogPost, StorePage, StorePageRevision, StoreLocation, SizeChart. It refuses everything else (`MODEL_NOT_WRITABLE`), any write to `inventory` of Product/ProductVariant (`STOCK_WRITE_REFUSED`), unknown ops, empty or >200-op batches, and a row carrying another store's id.
- Idempotency: a keyed batch stores its result in `_idempotency` inside the same transaction; a replay returns it, a reused key with other ops is refused, a failed batch stores nothing, keys live 24 h.

| Moved write                                                                            | Models                                                 | Route             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------- |
| `BlogService.create`, `update`, `remove` (+ the reads they depend on)                  | BlogPost                                               | admin blog        |
| `PagesService.upsert`, `remove`                                                        | StorePage                                              | admin pages       |
| `LocationsService.create`, `update`, `remove`                                          | StoreLocation                                          | admin locations   |
| `SizeChartService.create`, `update`, `delete`, `list`, `get`, `assertSizeChartInStore` | SizeChart                                              | admin size charts |
| tag rename (`PUT /tags/:tagId`) and the tag list                                       | Tag                                                    | admin tags        |
| category list, create, update, soft delete, reorder, product reorder inside a category | Category, ProductCategory                              | admin categories  |
| `VariantService.addOption`, `updateOption`                                             | ProductOption (+ nested values), Product `hasVariants` | admin variants    |
| `ProductService.bulkSetLowStockThreshold`                                              | Product `lowStockThreshold`                            | admin bulk        |

Customer erasure/export on the DO: `cf/erasure/registry.generated.ts` is generated from `erasure-classification.json` by `scripts/cf/gen-erasure-registry.mjs` (`npm run cf:erasure-registry`, `--check` in CI), covers all 122 schema tables plus the two runtime tables, and is exercised against the real DO schema (Ruling CF-ERASE-3).

### Residuals of D1 (accepted, Ruling CF-WRITES-1)

1. On `do`, the reads and the write of one handler are separate RPCs; on `pg` they share the request transaction. Unique indexes and `where: { id, storeId }` carry the guarantee, as they do between concurrent requests today.
2. `recordSlugRedirect(prisma, ...)` on a slug change still writes `SlugRedirect` to Postgres (a D1 platform model: the platform client of PR A).
3. A method that reads a model that has not moved (for example `ProductService.getById` includes the D1 `Store`) keeps reading Postgres.

## Writes moved in PR D1b (Rulings CF-WRITES-2)

Same mechanism as D1, plus named in-DO procedures (`$proc`, `DO_PROCS`) for the one statement Prisma cannot express (`mergeAiFieldSources`, the `ai_field_sources` delta merge) and the settings write-through.

| Moved write                                                                                                               | Notes                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product create, update, soft delete, `bulkUpdate` (status, flags, category link, price), `bulkDelete`, `bulkUpdateStatus` | `update` has a Postgres transaction path (unchanged) and a DO batch path (`updateOnDo`) sharing one `updateArgs`; the D1 `store` relation of `getById` is attached separately on the DO |
| Variants: option values add/update/delete, create/update/delete/generate/reorder, option delete + reorder                 | non-zero `inventory` is refused on the DO (stock = D2)                                                                                                                                  |
| Page-builder revisions (save draft, publish, rollback, list)                                                              | the head rev is `findFirst(orderBy rev desc)` on the DO, `aggregate` on Postgres                                                                                                        |
| Price tiers, product relations (replace-all is now atomic), product FAQ                                                   |                                                                                                                                                                                         |
| AI writers: product copy / category SEO / image alt / tags / FAQs / category links, store-category suggestions            | one batch with generated ids; jobs still READ through Postgres (PR E)                                                                                                                   |
| Settings copy: 12 `StoreService` writers via `updateStoreThrough`                                                         | D1/Postgres `Store` first, then `StoreDO.applySettings` into `store_profile` / `store_config`                                                                                           |

Collections: there is no `Collection` model; the storefront's collection surfaces are `Category` and the page-builder document (`pageKey` collection), both already DO models.

### Settings copy: every Store write is routed (PR D1c, Ruling CF-WRITES-3)

The cutover gate of CF-WRITES-2 is closed. The 39 direct `store.update` / `updateMany` calls and 4 raw `UPDATE stores ... jsonb_set` writes now go through `storeUpdate` / `storeUpdateMany` / `syncStoreFields` (`lib/repo-factory.ts`) or `updateStoreThrough` (`StoreService`). `tests/unit/store-settings-routed.test.ts` walks `apps/api/src` with the TypeScript AST and fails on a new direct write; the only allow-listed file is `lib/repo-factory.ts` (it holds the helpers' own call). A relation write (`credentials`) is directory-only in the copy.

```ts
await storeUpdate(tx, { where: { id: storeId }, data: { pwaEnabled } }); // authoritative write on YOUR client, then the DO copy
await storeUpdateMany(tx, {
  where: { id: storeId, pendingDomain },
  data: { domainStatus: 'failed' },
}); // copies only if a row matched
await syncStoreFields(storeId, ['settings']); // after a raw jsonb_set: re-read, copy the whole value
```

## Stock and inventory on the DO (PR D2a, Ruling CF-STOCK-1)

```ts
const stock = await storeStock(storeId); // null on Postgres
if (stock)
  return doPath(await stock.adjustProduct({ productId, quantity: -2, type: 'manual_remove' }));
// ...the unchanged Postgres code follows
```

One named operation per admin stock write, each ONE `transactionSync` section in the DO (single thread = the lock), reached through `StoreDO.stockOp` (separate from `mutate`, which still refuses stock columns). Optional idempotency key per call (marker row in `_stock_ops`, 24 h). Code: `packages/repo/src/do/stock-ops.ts`, `rpc/stock.ts`, client `makeStockClient` in `lib/repo-factory.ts`.

| Operation                                   | Service call that uses it                  | Route                   |
| ------------------------------------------- | ------------------------------------------ | ----------------------- |
| `adjustProduct`                             | `InventoryService.adjustInventory`         | admin inventory adjust  |
| `setProduct`                                | `InventoryService.setInventory`            | admin inventory count   |
| `bulkAdjustProducts`                        | `InventoryService.bulkAdjustInventory`     | admin inventory bulk    |
| `setVariantInventory`                       | `VariantService.bulkUpdateInventory`       | variants bulk-inventory |
| `setWarehouseStock`, `adjustWarehouseStock` | `WarehouseService.setStock`, `adjustStock` | admin warehouse stock   |

Contract tests: `packages/repo/test/do-stock-ops.test.ts` (engine), `tests/integration/repo-factory-stock-contract.test.ts` (real services on Postgres vs the DO schema, equal traces and tables), `apps/api/workers-do/stock.test.ts` (real workerd, 100 concurrent removals never oversell). Not moved yet, with reason: CSV import (stock and non-stock share one interactive transaction with D1 slug redirects and gold specs: needs the import orchestrator), opening stock and `inventoryHistory` inside product/variant create, warehouse CRUD, barcode sequences, reservations/hold cap (an open hold is an unpaid order: D2b).

## Money operations on the DO (PR D2b, Ruling CF-MONEY-1)

```ts
const money = await storeMoney(storeId); // null on Postgres
if (money) return doPath(await money.loyaltyEarn({ customerId, orderId, featureEnabled }));
// ...the unchanged Postgres code follows
```

The twin of the stock operations: `StoreDO.moneyOp` -> `answerMoneyOp` -> `runMoneyOp` (`packages/repo/src/do/money-ops.ts`), one named operation = one `transactionSync` section, optional idempotency key as a marker row in the same section (`_money_ops`, shared discipline `do/keyed-op.ts`), a refusal is an answer. Money never moves through `mutate`. External money facts are recorded in full (a reversal after the customer spent the points reverses what the balance holds and still records the full row); they are never rejected.

| Operation                                        | Service call that uses it                                                       | Caller                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `loyaltyEarn`                                    | `LoyaltyService.earnPointsFromPurchase`                                         | `order-status-changed` fanout (delivered) |
| `loyaltyReverseEarned`, `loyaltyReverseRedeemed` | `LoyaltyService.reverseEarnedPointsFromOrder`, `reverseRedeemedPointsFromOrder` | `order-refunded` fanout                   |

Contract tests: `tests/integration/repo-factory-money-contract.test.ts` (real service on Postgres vs the DO schema, equal traces and tables), `packages/repo/test/do-money-ops.test.ts`, `apps/api/workers-do/money.test.ts` (real workerd). Also in D2b: `aggregate` and `groupBy` are read ops (`having`, `orderBy` an aggregate, `take`/`skip`; everything else refused loudly), enum columns sort in the Postgres enum order (`prisma-lite/enum-order.ts`, checked against `pg_enum`), `reconcileWarehouseStockToAggregate` never makes a row negative on either backend (WAREHOUSE-NEG-1), and event jobs without a `storeId` resolve their store through `EVENT_STORE_RESOLVERS` (`docs/cf/jobs-on-do.md`).

Orders (PR D2b-2, Rulings CF-ORDERS-1, CF-ORDERS-CART-1): `createOrder`, `confirmPayment`, `cancel`, `expireHold` are money operations too; the map of the Postgres transactions, the differences found and the residuals are in `docs/cf/orders-on-do.md`.

## Left for D2 or later from the D1b list (with reason)

| Item                                                                                           | Reason                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bulk CSV import transactions (`bulk.service.ts` product and variant import)                    | DONE in R3 (IMPORT-DO-1): `importBatch` / `importVariants` money ops; slug redirects and gold specs follow the commit; the post-import barcode fill stays Postgres-only (barcode sequences, below) |
| `VariantService.bulkUpdateInventory`, variant `inventoryHistory` rows, opening stock on create | stock columns                                                                                                                                                                                      |
| Barcode sequences (`barcode.service.ts`)                                                       | advisory lock + sequence                                                                                                                                                                           |
| Provisioning seeds (`provisioning.service.ts`)                                                 | the store does not exist in a DO yet; the import carries them                                                                                                                                      |
| `ai-autofill-cleanup`                                                                          | mixes D2 models (AiRecommendation, FrequentlyBoughtTogether) in one transaction                                                                                                                    |
| Job READS (every `bulk-ai-*` selects through Postgres)                                         | PR E                                                                                                                                                                                               |

## Left for PR D2 (money, stock and lock paths; measured on this branch, `apps/api/src`)

| Class                                                                                     | Sites                                                                                                                                                                                                                          | Detail                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| raw SQL (`$queryRaw`/`$executeRaw`)                                                       | 265 in 80 files                                                                                                                                                                                                                | plan task 2.2 inventory (`scripts/cf/raw-sql-inventory.sh`); each becomes an explicit DO repo method                      |
| row locks (`FOR UPDATE`, advisory locks)                                                  | 74 lines in 34 files                                                                                                                                                                                                           | one synchronous `transactionSync` section each (plan 3.1 lock map)                                                        |
| orders                                                                                    | `order.service.ts` (33 order writes, 4 orderItem), `cart.service.ts`, `mcp/tools/order.tools.ts`, `lib/inngest/functions/order-auto-cancel-unpaid.ts`                                                                          | checkout, status transitions, auto-cancel; engine `packages/repo/src/do/checkout.ts`                                      |
| payments and webhooks                                                                     | `payment-providers/*` (`instapay.service.ts`, `refund-settle.ts`), `payment-state-claims.ts` (payment 24, paymentEvent 12 writes), `routes/merchant-webhooks.routes.ts`                                                        | engine `do/payments.ts`; webhook routing needs the entity index in D1                                                     |
| refunds, returns                                                                          | `return.service.ts` (7 return, 1 returnItem), `lib/inngest/functions/order-refunded.ts`, `refund-reversal-stuck-sweep.ts`, `accounting/posting/refund-posting.ts`, `partial-return-posting.ts`                                 | engine `do/refund.ts`; returns and ledger posting on the DO not found                                                     |
| ledger and accounting                                                                     | `services/accounting/*` (journal 2 writes, `backorder.service.ts`, `backorder-stock-heal.ts`, `purchase-order.service.ts`, `stock-adjustment.service.ts`)                                                                      | posting and the immutable-ledger triggers                                                                                 |
| stock and reservations                                                                    | `inventory.service.ts`, `inventory-decrement.ts`, `stock-hold-cap.ts`, `warehouse.service.ts`, `routes/warehouse.routes.ts`, `lib/inngest/functions/warehouse-reconcile-sweep.ts`, `barcode*.ts`, inventoryHistory (15 writes) | engine `do/stock.ts`; the `inventory` column is refused by the D1 write path on purpose                                   |
| coupons                                                                                   | `lib/coupon-per-customer-limit.ts`, coupon (11 writes)                                                                                                                                                                         | engine `do/promotions.ts`                                                                                                 |
| wallet and loyalty                                                                        | `wallet.service.ts`, `loyalty.service.ts` (loyaltyPoints 12, loyaltyTransaction 13 writes)                                                                                                                                     | loyalty earn + both reversals DONE in D2b (`moneyOp`); redeem (inside the order transaction), bonus awards, wallet remain |
| gold repricing                                                                            | `gold-rate/*`, `Product`/`ProductVariant` price writes under `do_flags.gold_reprice`                                                                                                                                           | the only writer of gold-rate prices; engine `do/gold.ts`                                                                  |
| `aggregate` / `groupBy`                                                                   | 59                                                                                                                                                                                                                             | DONE in D2b: read ops on the RPC, contract-tested against Postgres                                                        |
| interactive transactions (`withMoneyTx`, `$transaction(async ...)`, `runInTenantContext`) | 348 call sites                                                                                                                                                                                                                 | a DO section is `transactionSync`, not a pooled-connection transaction                                                    |
| security definer lookups (`lib/definer.ts`)                                               | 72 files                                                                                                                                                                                                                       | pre-store host/slug lookups belong to the D1 platform repo                                                                |
| D1 platform models (`Store`, `User`, `StoreStaff`, `SlugRedirect`, plans/billing)         | `prisma.store.*` 110 sites                                                                                                                                                                                                     | the D1 platform client (PR A binding)                                                                                     |
| jobs and webhooks                                                                         | resolve their store through Postgres today                                                                                                                                                                                     | PR E (`storeDb`/`storeWriter` already answer outside a request)                                                           |

Until D2 lands, flipping a store to `do` would serve its moved reads and writes from a Durable Object while orders, stock, payments and everything else still write Postgres. The flag stays `pg` for every store; the cutover runbook gate (rows 1-3) is what makes a flip legal.
