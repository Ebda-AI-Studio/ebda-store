# Post-response work on a committed tenant transaction (P2028) — 2026-09-08

Companion to `2026-06-09-rls-async-writer-audit.md`, which covered the OPPOSITE
failure: async paths that run with NO tenant context. This one covers async work
that runs with a tenant context it should no longer be using.

## The defect

`apps/api/src/middleware/tenant-context.ts` runs each store-scoped request inside
ONE Prisma interactive transaction, held in AsyncLocalStorage.

> **Note added 2026-09-08 (merge of #1587 with #1596).** When this audit was
> written the transaction committed on `res.on('finish')` — i.e. **after** the
> response was flushed. It now commits BEFORE the response is released
> (`middleware/request-transaction.ts`). That does not change the defect or the
> fix; it makes the window **wider**, because the transaction now settles a
> whole event-loop turn earlier than it used to. Every measurement below still
> holds, and the "single un-awaited query, handler does one DB round-trip first"
> row is now a race rather than a pass.

A fire-and-forget promise started inside a handler (`void Svc.doThing(...)`)
inherits that AsyncLocalStorage context. Any Prisma query it makes once that
transaction has settled lands on an already-committed transaction:

```
Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.
PrismaClientKnownRequestError (P2028)
```

Every affected call site wraps itself in a logging `.catch`, so the work
**silently never happened** and nothing alerted.

The repo already knew about the shape — `routes/index.ts` keeps
`recommendationRoutes` deliberately CONTEXT-LESS with the comment "wrapping the
request would let the outer tx commit while the detached work is still running,
then hit 'transaction already closed'". Routers that ARE wrapped never got the
same treatment.

### Measured, not assumed

An Express + local-Postgres probe (reproduced as
`tests/integration/after-tenant-commit.test.ts`) measured the window:

| detached work shape                                                  | result                        |
| -------------------------------------------------------------------- | ----------------------------- |
| single un-awaited Prisma query, handler responds immediately         | **P2028**                     |
| single un-awaited Prisma query, handler does one DB round-trip first | passes                        |
| one `await` before the Prisma call                                   | **P2028** (flaky-to-reliable) |
| two or more chained Prisma calls                                     | **P2028** every run           |
| Prisma call behind a timer                                           | **P2028** every run           |

So it is a race, and the race is lost as soon as the detached work has any
`await` before its query — or the handler answers promptly. Single-query sites
are non-deterministically dropped; multi-hop sites (every email path) are
deterministically dropped.

## Per-site classification

A site is defective only when ALL of: (a) it starts inside a request that runs
under `tenantContext`/`userContext`, (b) the promise performs a Prisma query
directly or transitively, (c) that query can execute after the response flushes.

Router context was verified per mount in `apps/api/src/routes/index.ts` — a
`tenantContext` argument at a BARE mount (`/stores`, `/admin`) is a documented
no-op; those routers only get context if they register
`router.param('storeId', tenantContext)` themselves.

| #   | site                                                                                                                                                                                                                                                                                                                                                           | async work                                                           | under tenant tx?                                                                                                                                    | Prisma?                                                                         | verdict                                                                                                                                                              | action                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `services/return.service.ts:370`                                                                                                                                                                                                                                                                                                                               | `EmailService.sendReturnConfirmation`                                | YES — `/stores/:storeId/returns`                                                                                                                    | YES (3 reads, last at `resend.service.ts:290`)                                  | **DEFECTIVE (deterministic)** — every return confirmation silently unsent                                                                                            | deferred + `{ queue: true }`                                                                                         |
| 2   | `services/return.service.ts:462`                                                                                                                                                                                                                                                                                                                               | `EmailService.sendReturnStatusUpdate`                                | YES — same router                                                                                                                                   | YES (3 reads)                                                                   | **DEFECTIVE (deterministic)** — same class, not in the original report                                                                                               | deferred + `{ queue: true }`                                                                                         |
| 3   | `services/affiliate.service.ts:194,239,332,356,376,528,580,681` (8 sites)                                                                                                                                                                                                                                                                                      | `recordAffiliateEvent` — a DB **write**                              | YES — `affiliate.routes.ts` registers `router.param('storeId', tenantContext)`                                                                      | YES (1 `affiliateEvent.create`)                                                 | **DEFECTIVE (racy)** — append-only affiliate audit rows dropped whenever the handler responds promptly                                                               | fixed inside `recordAffiliateEvent` (sweeps all 8)                                                                   |
| 4   | `services/r2-cleanup.service.ts` via `deleteR2ObjectIfOrphan` — called `void`-style from `store.service.ts:388,758,906`, `product.service.ts:963`, `variant.service.ts:256,387,542,583`, `pages.service.ts:302,331`, `blog.service.ts:207,219`, `category.routes.ts:120,538`, `typography.routes.ts:156`, `store-layout.routes.ts:791`, `auth.service.ts:1001` | `isStillReferenced`                                                  | YES for the product / variant / category / pages / blog / typography / layout callers (all under `/stores/:storeId/...` or a `router.param` router) | YES — **11** parallel reads                                                     | **DEFECTIVE (deterministic)** — swallowed as "[r2-cleanup] failed to delete orphan R2 object", so the object leaks: the exact failure this service exists to prevent | fixed inside `deleteR2ObjectIfOrphan` (sweeps every caller, incl. `cleanupRemovedImages` / `cleanupRemovedJsonUrls`) |
| 5   | `services/auth.service.ts:131`                                                                                                                                                                                                                                                                                                                                 | `EmailService.sendDuplicateRegistrationNotice`                       | **NO** — `/auth` is mounted bare (`routes/index.ts:77`), no `tenantContext`, no `router.param`                                                      | YES                                                                             | not defective                                                                                                                                                        | none                                                                                                                 |
| 6   | `services/auth.service.ts:180`                                                                                                                                                                                                                                                                                                                                 | `this.sendVerificationEmail`                                         | **NO** — same router                                                                                                                                | YES                                                                             | not defective                                                                                                                                                        | none                                                                                                                 |
| 7   | `services/auth.service.ts:314`                                                                                                                                                                                                                                                                                                                                 | `EmailService.sendWelcome`                                           | **NO** — same router                                                                                                                                | YES                                                                             | not defective                                                                                                                                                        | none                                                                                                                 |
| 8   | `services/store.service.ts:758`                                                                                                                                                                                                                                                                                                                                | `cleanupRemovedImages`                                               | NO at the store router (bare `/stores`, no `router.param` — `routes/index.ts:159` documents it as CONTEXT-LESS)                                     | YES                                                                             | not defective **on today's mount**                                                                                                                                   | covered anyway by the helper-level fix (so it stays correct if the router is ever wrapped in RLS Phase 2)            |
| 9   | `routes/store-layout.routes.ts:791`                                                                                                                                                                                                                                                                                                                            | `cleanupRemovedJsonUrls`                                             | YES — `/admin/stores/:storeId/layout`                                                                                                               | YES (→ `deleteR2ObjectIfOrphan`)                                                | **DEFECTIVE (deterministic)**                                                                                                                                        | covered by the helper-level fix                                                                                      |
| 10  | `routes/store.routes.ts:1307`                                                                                                                                                                                                                                                                                                                                  | `domainSvc.removeDomain`                                             | NO — context-less router                                                                                                                            | NO — Cloudflare/Resend HTTP only                                                | not defective                                                                                                                                                        | none                                                                                                                 |
| 11  | `routes/store.routes.ts:1328,1330`, `routes/store-layout.routes.ts:810`                                                                                                                                                                                                                                                                                        | `invalidateCached`                                                   | :810 yes / :1328,1330 no                                                                                                                            | **NO** — `lib/public-cache.ts` touches Redis + an in-memory Map only            | not defective                                                                                                                                                        | none                                                                                                                 |
| 12  | `index.ts:485,700`, `services/store.service.ts:558`, `routes/wbs-integration.routes.ts:504`, `payment.factory.ts:976,1384,1588`, `payment-confirm.service.ts:191`, and the three Inngest functions (`store-usage-snapshot:194`, `order-auto-cancel-unpaid:307`, `r2-orphan-sweep:307`)                                                                         | `sendAlert`                                                          | mixed (health check + process handlers + context-less routers + Inngest)                                                                            | **NO** — `alerts.service.ts` is Redis throttle + `fetch` to Telegram, no Prisma | not defective at ANY site                                                                                                                                            | none                                                                                                                 |
| 13  | `routes/mcp.routes.ts:34,35`                                                                                                                                                                                                                                                                                                                                   | `transport.close()` / `server.close()`                               | NO — `routes/index.ts:74` documents "no auth middleware or tenantContext here"                                                                      | NO                                                                              | not defective                                                                                                                                                        | none                                                                                                                 |
| 14  | Inngest functions generally                                                                                                                                                                                                                                                                                                                                    | `sendAlert`, `inngest.send`                                          | **NO** — served through `inngestServe` in `index.ts`; no HTTP tenant middleware wraps them (confirmed, not assumed)                                 | n/a                                                                             | not defective                                                                                                                                                        | none                                                                                                                 |
| 15  | `services/shipping-carrier.service.ts:380` — **not in the original report**                                                                                                                                                                                                                                                                                    | `void prisma.store.findUnique(...).catch(() => null).then(dispatch)` | NO — `shippingCarrierRoutes` is documented CONTEXT-LESS (`routes/index.ts:260`); also reached from an Inngest fn                                    | YES (1 read)                                                                    | not defective today, but **latent**: `.catch(() => null)` would degrade the notification's store name to the raw store id rather than fail                           | left as-is; see Residuals                                                                                            |
| 16  | `services/payment-confirm.service.ts:303`                                                                                                                                                                                                                                                                                                                      | `void runInTenantContext(order.storeId, …)`                          | opens its **own** `basePrisma.$transaction`                                                                                                         | YES, in its own tx                                                              | not defective — and it is the precedent this fix generalises                                                                                                         | none                                                                                                                 |
| 17  | `services/provisioning.service.ts:243,258`                                                                                                                                                                                                                                                                                                                     | `domainSvc.removeDomain`, `EmailService.sendWelcome`                 | NO — `adminRoutes` is a bare `/admin` mount, documented CONTEXT-LESS                                                                                | YES for the email                                                               | not defective                                                                                                                                                        | none                                                                                                                 |
| 18  | `services/product.service.ts:753,949,987`                                                                                                                                                                                                                                                                                                                      | `inngest.send`                                                       | YES (product router)                                                                                                                                | NO — HTTP to Inngest                                                            | not defective                                                                                                                                                        | none                                                                                                                 |

## The fix

`apps/api/src/lib/after-tenant-commit.ts`

- `withDeferredWork(ctx, fn, onCommitted?)` — wraps the request's
  `runInTenantContext` call in `tenant-context.ts` (both `tenantContext` and
  `userContext`), collecting deferred tasks and draining them **after** the
  transaction commits. `onCommitted` is `request-transaction.ts`'s
  `releaseResponse` callback, fired between the COMMIT and the drain, which
  fixes the one ordering the two changes could disagree about:

      COMMIT  ->  response released to the client  ->  deferred work drains

  Draining before the COMMIT is the defect this file is about; draining before
  the release would put an email round-trip on the request's latency path,
  which the old commit-on-`finish` wiring never did. Asserted end-to-end in
  `apps/api/src/middleware/__tests__/deferred-work-lifecycle.test.ts` and
  `tests/integration/deferred-work-lifecycle.test.ts`.

- `deferAfterTenantCommit(name, run)` — queues `run` when a request transaction
  is in play; otherwise runs it inline and returns its result unchanged, so
  Inngest / cron / script paths are byte-identical to before.
- Each drained task runs in a **fresh** `runInTenantContext(storeId, …, userId)`,
  re-establishing `app.current_store_id` and `app.current_user_id`. Escaping
  AsyncLocalStorage to grab a bare client would have dropped those GUCs and
  traded a transaction bug for a tenancy bug; this does not.
- A request that returns 5xx rolls its transaction back — and, since #1596, so
  does a request whose COMMIT itself fails (which now surfaces to the client as
  a 500 instead of a 201 over a lost write). Either way its deferred work is
  **dropped** — the rows it reacts to no longer exist.
- A failing task logs at error level AND fires the standard Telegram alert
  (`sendAlert`, `p1`, `source: after-tenant-commit.<task>`). Remaining tasks
  still run.

Return emails additionally move onto the durable Redis retry queue
(`{ queue: true }` in `email.service.ts`), matching the order-lifecycle emails
per CLAUDE.md: the render's two Prisma reads happen inside the fresh tenant
transaction, and only the Resend call is handed to the queue drainer.

## Stopping it recurring

`packages/database/src/index.ts` now marks a tenant transaction as closed the
moment `runInTenantContext`'s callback returns, and the `prisma` proxy reports
any subsequent access through an injectable reporter
(`onClosedTenantTxAccess`). `installClosedTenantTxAlerting()` (called at boot in
`apps/api/src/index.ts`) wires that to `logger.error` + `sendAlert`.

**Detection only** — the query still routes to the closed transaction and still
throws P2028 exactly as before, so no behaviour changes. What changes is that a
site we missed, or one added later, names itself the first time it fires instead
of dying inside somebody's `.catch`.

A static lint rule was considered and rejected: the defect is "this promise
transitively reaches Prisma", which no `no-restricted-syntax` pattern can decide
(`void EmailService.sendX()` is defective, `void sendAlert()` is not, and both
are the same AST shape). The runtime detector is the enforceable gate.

## Residuals

- **`shipping-carrier.service.ts:380`** keeps its `.catch(() => null)` around a
  `prisma.store.findUnique`. Harmless today (context-less router), but if
  `shippingCarrierRoutes` is ever wrapped in RLS Phase 2 the notification would
  silently render the store id where the store name belongs. Not changed here
  because the task is strictly additive and this path works today.
- **The RLS Phase 2 candidates** (`storeRoutes`, `adminRoutes`, `featureRoutes`,
  `inventoryRoutes`, `shippingCarrierRoutes`, `newsletterRoutes`,
  `wbsIntegrationRoutes`, `financeRoutes`, `smartLayerRoutes`, `insightsRoutes`,
  `recommendationRoutes`, `notificationRoutes`) are only safe to wrap once their
  detached work goes through `deferAfterTenantCommit`. The r2-cleanup and
  affiliate-event helpers are already covered, which removes part of that
  blocker; `recalculateFBT` (recommendationRoutes) is not and would need the
  same treatment first.
- ~~A one-line rule for the repo `CLAUDE.md` ("fire-and-forget work started
  inside a store-scoped request must go through `deferAfterTenantCommit`") is
  worth adding but is left to Ahmad — this change did not edit `CLAUDE.md`.~~
  **Done 2026-09-08** as part of the #1587 x #1596 merge: the RLS bullet in
  `CLAUDE.md` and the Consequences section of `docs/adr/0001-fwb-tenant-isolation.md`
  both now state the rule and the `COMMIT -> response -> drain` order.
