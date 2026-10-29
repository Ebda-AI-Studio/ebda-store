# Repo factory: reads and non-money writes on the store's backend (INFRA-CF-1 PR C + D1, Rulings CF-REPO-1, CF-WRITES-1, CF-ERASE-3)

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

## Left for PR D1b (non-money catalogue, same mechanism, not yet moved; measured on this branch)

| Group                                          | Sites (non-test)                                                                                                                                                                         | Why it did not move in D1                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Product create/update/delete/restore           | `product.service.ts` (`create`, `update` inside `withMoneyTx` with nested images/categories, `$queryRaw` on `ai_field_sources`, soft delete via `getById` which includes the D1 `Store`) | interactive transaction + raw SQL + a D1 relation include; needs the interactive-tx rewrite and the platform client |
| Variants generate/update/delete, option values | `variant.service.ts` (`withMoneyTx`, `withSavepoint`, `inventoryHistory` rows, stock columns)                                                                                            | writes `inventory` (refused by design) and history rows; moves with the stock sections in D2                        |
| Page builder revisions                         | `page-builder.service.ts` (7 StorePageRevision writes)                                                                                                                                   | not reached in this slice; same mechanism                                                                           |
| Bulk and AI writers                            | `bulk.service.ts`, `lib/inngest/functions/bulk-ai-*` (tags, categories, images, FAQs, product copy), `ai-autofill*.ts`, `store-category-suggest`, `provisioning`                         | jobs resolve the store through Postgres today (PR E); `storeWriter` already answers outside a request               |
| Price tiers, recommendations, product FAQ      | `price-tier.service.ts` (3), `recommendation.service.ts` (ProductRelation 5), `routes/product.routes.ts` (ProductFaq)                                                                    | same mechanism, not yet moved                                                                                       |
| Media                                          | no media table: product images are ProductImage rows (above) + R2 objects                                                                                                                | R2 side is unchanged                                                                                                |
| Collections                                    | no `Collection` model exists in the schema                                                                                                                                               | nothing to move                                                                                                     |
| Settings copy                                  | store settings live on the D1 `Store` model (`prisma.store.*`, 110 sites)                                                                                                                | D1 platform client (PR A binding), not a store DO                                                                   |

## Left for PR D2 (money, stock and lock paths; measured on this branch, `apps/api/src`)

| Class                                                                                     | Sites                                                                                                                                                                                                                          | Detail                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| raw SQL (`$queryRaw`/`$executeRaw`)                                                       | 265 in 80 files                                                                                                                                                                                                                | plan task 2.2 inventory (`scripts/cf/raw-sql-inventory.sh`); each becomes an explicit DO repo method |
| row locks (`FOR UPDATE`, advisory locks)                                                  | 74 lines in 34 files                                                                                                                                                                                                           | one synchronous `transactionSync` section each (plan 3.1 lock map)                                   |
| orders                                                                                    | `order.service.ts` (33 order writes, 4 orderItem), `cart.service.ts`, `mcp/tools/order.tools.ts`, `lib/inngest/functions/order-auto-cancel-unpaid.ts`                                                                          | checkout, status transitions, auto-cancel; engine `packages/repo/src/do/checkout.ts`                 |
| payments and webhooks                                                                     | `payment-providers/*` (`instapay.service.ts`, `refund-settle.ts`), `payment-state-claims.ts` (payment 24, paymentEvent 12 writes), `routes/merchant-webhooks.routes.ts`                                                        | engine `do/payments.ts`; webhook routing needs the entity index in D1                                |
| refunds, returns                                                                          | `return.service.ts` (7 return, 1 returnItem), `lib/inngest/functions/order-refunded.ts`, `refund-reversal-stuck-sweep.ts`, `accounting/posting/refund-posting.ts`, `partial-return-posting.ts`                                 | engine `do/refund.ts`; returns and ledger posting on the DO not found                                |
| ledger and accounting                                                                     | `services/accounting/*` (journal 2 writes, `backorder.service.ts`, `backorder-stock-heal.ts`, `purchase-order.service.ts`, `stock-adjustment.service.ts`)                                                                      | posting and the immutable-ledger triggers                                                            |
| stock and reservations                                                                    | `inventory.service.ts`, `inventory-decrement.ts`, `stock-hold-cap.ts`, `warehouse.service.ts`, `routes/warehouse.routes.ts`, `lib/inngest/functions/warehouse-reconcile-sweep.ts`, `barcode*.ts`, inventoryHistory (15 writes) | engine `do/stock.ts`; the `inventory` column is refused by the D1 write path on purpose              |
| coupons                                                                                   | `lib/coupon-per-customer-limit.ts`, coupon (11 writes)                                                                                                                                                                         | engine `do/promotions.ts`                                                                            |
| wallet and loyalty                                                                        | `wallet.service.ts`, `loyalty.service.ts` (loyaltyPoints 12, loyaltyTransaction 13 writes)                                                                                                                                     | engine `do/loyalty.ts`, wallet entry in `do/refund.ts`                                               |
| gold repricing                                                                            | `gold-rate/*`, `Product`/`ProductVariant` price writes under `do_flags.gold_reprice`                                                                                                                                           | the only writer of gold-rate prices; engine `do/gold.ts`                                             |
| `aggregate` / `groupBy`                                                                   | 59                                                                                                                                                                                                                             | prisma-lite has the engine paths; not exposed on the RPC yet                                         |
| interactive transactions (`withMoneyTx`, `$transaction(async ...)`, `runInTenantContext`) | 348 call sites                                                                                                                                                                                                                 | a DO section is `transactionSync`, not a pooled-connection transaction                               |
| security definer lookups (`lib/definer.ts`)                                               | 72 files                                                                                                                                                                                                                       | pre-store host/slug lookups belong to the D1 platform repo                                           |
| D1 platform models (`Store`, `User`, `StoreStaff`, `SlugRedirect`, plans/billing)         | `prisma.store.*` 110 sites                                                                                                                                                                                                     | the D1 platform client (PR A binding)                                                                |
| jobs and webhooks                                                                         | resolve their store through Postgres today                                                                                                                                                                                     | PR E (`storeDb`/`storeWriter` already answer outside a request)                                      |

Until D2 lands, flipping a store to `do` would serve its moved reads and writes from a Durable Object while orders, stock, payments and everything else still write Postgres. The flag stays `pg` for every store; the cutover runbook gate (rows 1-3) is what makes a flip legal.
