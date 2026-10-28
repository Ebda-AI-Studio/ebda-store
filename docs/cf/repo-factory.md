# Repo factory: reads on the store's backend (INFRA-CF-1 PR C, Ruling CF-REPO-1)

Code: `apps/api/src/lib/repo-factory.ts` (factory + request scope), `packages/repo/src/rpc/*` (wire codec, read executor, Worker-side client), `apps/api/src/cf/store-do/store-do.ts` (`query()`), `lib/store-backend.ts` (`backendFor`, the flag). Contract tests: `tests/integration/repo-factory-contract.test.ts` (Postgres vs the Durable Object schema), `tests/unit/repo-factory.test.ts`, `apps/api/workers-do/store-do-schema.test.ts` (real workerd).

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

## Left for PR D (measured on main + this PR, `apps/api/src`)

| Class                                                                                            | Sites                                      | Why it cannot move with the factory                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| raw SQL (`$queryRaw`/`$executeRaw`)                                                              | 265 in 80 files                            | prisma-lite has no raw path; each needs an explicit DO repo method (plan task 2.2 inventory, `scripts/cf/raw-sql-inventory.sh`) |
| row locks (`FOR UPDATE`, advisory locks)                                                         | 74 lines in 34 files                       | become one synchronous `transactionSync` section in the DO (plan 3.1 lock map)                                                  |
| security definer lookups (`lib/definer.ts`)                                                      | 72 files reference it                      | pre-store host/slug lookups belong to the D1 platform repo, not a store DO                                                      |
| writes (`create/update/upsert/delete*`)                                                          | ~955                                       | `StoreDO.query` is read-only by design; writes need `$transaction`, nested writes, error-code mapping, then money paths         |
| `aggregate` / `groupBy`                                                                          | 59                                         | not implemented in the read executor (prisma-lite has the engine paths; they are not exposed yet)                               |
| interactive transactions (`withMoneyTx`, `$transaction(async ...)`, `runInTenantContext`)        | ~900                                       | a DO section is `transactionSync`, not a pooled-connection transaction                                                          |
| models that live in D1, not a store DO (Store, User, StoreStaff, SlugRedirect, plans/billing...) | `prisma.store.*` alone is ~227 reads       | need the D1 platform client (PR A/#300 binding), not this factory                                                               |
| money/stock paths (checkout, refunds, wallet, loyalty, coupons, inventory)                       | engines exist in `packages/repo/src/do/*`  | wiring the engines behind the routes (PR D), with the lock map and the phase 3 gate                                             |
| jobs and webhooks                                                                                | resolve their store through Postgres today | PR E (`storeDb` already answers outside a request, so a job can call it once it is moved)                                       |
| customer erasure/export on the DO                                                                | registry empty, refuses                    | generate `cf/erasure/registry.ts` from `erasure-classification.json` (G10)                                                      |

Until PR D lands, flipping a store to `do` would serve its moved reads from an EMPTY or stale Durable Object while everything else still writes Postgres. The flag stays `pg` for every store; the cutover runbook gate (rows 1-3) is what makes a flip legal.
