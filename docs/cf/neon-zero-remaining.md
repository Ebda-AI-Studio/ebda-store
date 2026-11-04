# NEON-ZERO: what still reaches Postgres after every Neon PR merges

Input for the final PRs N-15 (workers-test sweep with PG dead), N-16 (delete dead PG helpers / `@ebda/database` imports) and N-17 (remove Hyperdrive). Generated 2026-11-04 by PR `feat/nz-platform-d1-d` (N-10d).

## N-15 runtime route sweep (Postgres dead, all markers set)

Last run (`SWEEP_STRICT=1`) on `integ/neon-zero` d2565d820, after #435, #436 and the customer-auth routes: **909 requests, 242 2xx, 663 expected 4xx, 2 failing (5xx)**. History: 269 -> 26 -> 11 -> 2. The three optional-provider 503s (`PUSH_NOT_CONFIGURED` OneSignal broadcasts, `STORAGE_NOT_CONFIGURED` upload list, `alerts_not_configured`) are the correct answer of a Worker without those services and are not counted.

### SWEEP_FAILING

| Route                                                     | Status | Owner   | Cause                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/notifications/onesignal/devices`              | 500    | unowned | `OneSignalService.listSubscriptions`: the merchant/admin push-device registry (`onesignal_subscriptions`, keyed by an identity user) is still a Postgres table; it needs a D1 table (or the identity service) |
| `DELETE /admin/notifications/onesignal/devices/:playerId` | 500    | unowned | same table                                                                                                                                                                                                    |

Reproduce: `cd apps/api && npm run cf:dry-run && SWEEP_STRICT=1 EBDA_WORKERS_TEST_DB_URL=postgresql://ebda_app:x@127.0.0.1:1/x npx vitest run --config vitest.workers.config.mts workers-test/route-sweep.test.ts --silent=false --reporter=verbose`.

## Method and limits (read first)

- Tree analysed: this branch (base `origin/feat/nz-platform-d1-b` = #415, which contains #407) merged with #410 (`feat/nz-access-auth`), #416 (`feat/nz-analytics-jobs`), #414 (`feat/nz-customer-auth-do`) and #408 (`feat/nz-store-create-on-do`) by `git merge-tree` (a read-only merge; 6 files conflict, none changes a finding). The N-10d code itself is part of the base here.
- Scan = a regex over `apps/api/src` (non-test `.ts`): `prisma|tx|db|client.<model>.<op>` for every model whose `model-split.json` target is `d1`, `identity` or `store-do` and that no PR above routes, plus `$queryRaw/$executeRaw`. Labels: **measured** for file:line, **inferred** for the DO-awareness column (a file is "DO-aware" when it mentions `storeRepo`, `storeMoney`, `storeDb(`, `storeWriter(`, `storeStock(`, `backendFor`, `storeWritesToDo`, `acrossAllStoresDb`, `storeUpdate`, `doStoreIdList` or `.backend === 'do'`; this says a branch EXISTS in the file, not that every use is behind it).
- Owner = the PR that moves the thing. A file touched by a PR is NOT proof that the PR covers the use: those rows say "verify".
- Every `withStore` / `withMoneyTx` / `runInStoreScope` call opens a Postgres transaction even when its callback only touches DO or D1 models (section F). N-16 must replace those, not only the model calls.

## Summary

| Class                                                                      | Call sites | File/model groups |
| -------------------------------------------------------------------------- | ---------- | ----------------- |
| Store (d1 target): no PR routes `prisma.store.*`                           | 258        | 119               |
| identity models (User, RefreshToken, VerificationToken, PasskeyCredential) | 143        | 48                |
| store-do models through the Postgres client                                | 1012       | 299               |
| `$queryRaw` / `$executeRaw`                                                | 251        | 171               |

## A. Platform D1-target models still served by Postgres (only `Store`)

All other D1-target models are routed: billing family (#407), platform + inbox (#415), access (#410: StoreStaff, StaffInvite), payments + ops + audit (this PR: InstapayReceipt, ManualPaymentClaim, StoreUsageSnapshot, CiInsight, AnswerEngineProviderConfig, audit rows). `Store` is split between D1 (directory columns) and the StoreDO (profile/config); #408 moves CREATE, `storeUpdate*` (N-18/N-26) moves most writes. Every row below is a READ or write through `prisma.store` that no PR moves.

| file:line                                                          | model | DO-aware file | owner                                                                    |
| ------------------------------------------------------------------ | ----- | ------------- | ------------------------------------------------------------------------ |
| `lib/ci/source.ts:115,311,330`                                     | Store | yes           | unowned                                                                  |
| `lib/inngest/functions/answer-engine-citation-scan.ts:269`         | Store | no            | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/bulk-ai-aeo.ts:140`                         | Store | yes           | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/campaign-send.ts:103`                       | Store | no            | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/gold-rate-feed-fetch.ts:161`                | Store | no            | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/gold-rate-staleness-watch.ts:99`            | Store | no            | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/gsc-ingest.ts:206`                          | Store | no            | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/order-capi-conversion.ts:84`                | Store | yes           | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/order-created.ts:202,205`                   | Store | yes           | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:1040,1043`                | Store | yes           | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-status-changed.ts:139,142`            | Store | yes           | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/queue-depth-watch.ts:131`                   | Store | no            | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/review-request.ts:141`                      | Store | yes           | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/stock-deadstock-scan.ts:103`                | Store | no            | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/stock-low-stock-alert.ts:116,214`           | Store | no            | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/stock-reorder-scan.ts:106`                  | Store | no            | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/store-usage-snapshot.ts:70`                 | Store | yes           | unowned; file touched by #416 (verify the use is covered)                |
| `lib/inngest/functions/wa-store-events.ts:232`                     | Store | no            | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/webhook-delivery.ts:144`                    | Store | yes           | unowned; file touched by #416 (verify the use is covered)                |
| `lib/jobs/gold-stores.ts:21`                                       | Store | yes           | unowned; file touched by #416 (verify the use is covered)                |
| `lib/jobs/store-db.ts:90`                                          | Store | yes           | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/order-tax.ts:50`                                              | Store | no            | unowned                                                                  |
| `lib/repo-factory.ts:1558,1715,1722,1764`                          | Store | yes           | unowned; file touched by #408/#416 (verify the use is covered)           |
| `lib/report-range.ts:45`                                           | Store | no            | unowned                                                                  |
| `lib/store-ai-switch.ts:23`                                        | Store | no            | unowned                                                                  |
| `lib/store-directory-reconcile.ts:124`                             | Store | yes           | unowned                                                                  |
| `lib/store-directory-sync.ts:100`                                  | Store | yes           | unowned                                                                  |
| `lib/store-members.ts:62`                                          | Store | no            | unowned; file touched by #410 (verify the use is covered)                |
| `lib/wa/plan-state.ts:117`                                         | Store | no            | unowned                                                                  |
| `mcp/merchant-auth.ts:186`                                         | Store | no            | unowned; file touched by #410 (verify the use is covered)                |
| `mcp/merchant-write.ts:80`                                         | Store | no            | unowned                                                                  |
| `mcp/resolve-store.ts:35`                                          | Store | no            | unowned                                                                  |
| `middleware/store-access.ts:13`                                    | Store | no            | unowned; file touched by #410 (verify the use is covered)                |
| `routes/admin.routes.ts:298,342,831,1533,1553,2079 (+1)`           | Store | yes           | unowned; file touched by #408/#410/#414/#416 (verify the use is covered) |
| `routes/agent-credential.routes.ts:65,110,173`                     | Store | yes           | unowned; file touched by #408 (verify the use is covered)                |
| `routes/ai.routes.ts:137,282,405,491,737,1710 (+2)`                | Store | yes           | unowned; file touched by #416 (verify the use is covered)                |
| `routes/barcode-labels.routes.ts:40`                               | Store | yes           | unowned                                                                  |
| `routes/billing.routes.ts:110`                                     | Store | no            | unowned; file touched by #408 (verify the use is covered)                |
| `routes/blog.routes.ts:54`                                         | Store | no            | unowned                                                                  |
| `routes/campaign-public.routes.ts:69,142`                          | Store | yes           | unowned                                                                  |
| `routes/campaign.routes.ts:562,639`                                | Store | yes           | unowned                                                                  |
| `routes/category.routes.ts:82,114`                                 | Store | yes           | unowned                                                                  |
| `routes/customers.routes.ts:125`                                   | Store | no            | unowned; file touched by #414 (verify the use is covered)                |
| `routes/feature.routes.ts:314`                                     | Store | no            | unowned                                                                  |
| `routes/fiscal-document.routes.ts:81`                              | Store | no            | unowned                                                                  |
| `routes/locations.routes.ts:36`                                    | Store | no            | unowned                                                                  |
| `routes/merchant-key.routes.ts:122`                                | Store | no            | unowned; file touched by #408 (verify the use is covered)                |
| `routes/newsletter.routes.ts:222`                                  | Store | yes           | unowned                                                                  |
| `routes/order.routes.ts:178`                                       | Store | no            | unowned                                                                  |
| `routes/payment-settings.routes.ts:263,338,475,628,711,804`        | Store | no            | unowned; file touched by #408 (verify the use is covered)                |
| `routes/payment.routes.ts:247,459`                                 | Store | no            | unowned; file touched by #408/#410 (verify the use is covered)           |
| `routes/provider-activation.routes.ts:88`                          | Store | no            | unowned                                                                  |
| `routes/public-store-layout.routes.ts:59`                          | Store | yes           | unowned                                                                  |
| `routes/public.routes.ts:588,1857,2015,2743,2873`                  | Store | yes           | unowned                                                                  |
| `routes/pwa.routes.ts:198`                                         | Store | no            | unowned                                                                  |
| `routes/qr.routes.ts:31`                                           | Store | no            | unowned; file touched by #408 (verify the use is covered)                |
| `routes/realtime.routes.ts:54`                                     | Store | no            | unowned; file touched by #408 (verify the use is covered)                |
| `routes/staff-invite.routes.ts:106`                                | Store | no            | unowned; file touched by #410 (verify the use is covered)                |
| `routes/store-layout.routes.ts:51,99`                              | Store | yes           | unowned                                                                  |
| `routes/store.routes.ts:792,1198,1282,1352,1394,1514 (+1)`         | Store | yes           | unowned; file touched by #408 (verify the use is covered)                |
| `routes/typography.routes.ts:32,69`                                | Store | yes           | unowned                                                                  |
| `routes/webhook.routes.ts:998`                                     | Store | yes           | unowned                                                                  |
| `services/abandoned-cart.service.ts:396`                           | Store | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/accounting/expense.service.ts:341`                       | Store | yes           | unowned                                                                  |
| `services/accounting/insights-narration.service.ts:65`             | Store | yes           | unowned                                                                  |
| `services/accounting/posting/wallet-posting.ts:56`                 | Store | no            | unowned                                                                  |
| `services/accounting/profit-anomaly.service.ts:288`                | Store | yes           | unowned                                                                  |
| `services/ai-autofill.service.ts:156,535`                          | Store | yes           | unowned                                                                  |
| `services/answer-engine/citation-scan.service.ts:104`              | Store | yes           | unowned                                                                  |
| `services/auth.service.ts:155,467`                                 | Store | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/billing/account.service.ts:105,145,163,188,238,332 (+2)` | Store | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered) |
| `services/billing/billing-notify.ts:63`                            | Store | no            | unowned                                                                  |
| `services/billing/comp-migration.ts:102,147`                       | Store | yes           | unowned                                                                  |
| `services/billing/grants.service.ts:651`                           | Store | no            | unowned; file touched by #407/#410/#415/#416 (verify the use is covered) |
| `services/billing/reminders.service.ts:108`                        | Store | no            | unowned; file touched by #407/#410/#415/#416 (verify the use is covered) |
| `services/billing/subscription-billing.service.ts:805,926,2215`    | Store | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered) |
| `services/campaign.service.ts:63`                                  | Store | yes           | unowned                                                                  |
| `services/card-testing-guard.service.ts:191`                       | Store | no            | unowned                                                                  |
| `services/cart-recovery-email.service.ts:289`                      | Store | yes           | unowned                                                                  |
| `services/ci-hints.service.ts:118`                                 | Store | yes           | unowned                                                                  |
| `services/customer-auth-flows.ts:112`                              | Store | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/domain-claim.service.ts:88,115,163,188,222,269`          | Store | yes           | unowned                                                                  |
| `services/email.service.ts:386,535,587,627,660,693 (+13)`          | Store | no            | unowned                                                                  |
| `services/feature.service.ts:195,253,378`                          | Store | yes           | unowned                                                                  |
| `services/fiscal-document.service.ts:327`                          | Store | yes           | unowned                                                                  |
| `services/inventory.service.ts:980`                                | Store | yes           | unowned                                                                  |
| `services/inventory/low-stock-scan.service.ts:148`                 | Store | yes           | unowned                                                                  |
| `services/invoice.service.ts:226`                                  | Store | yes           | unowned                                                                  |
| `services/legal-notice.service.ts:230`                             | Store | no            | unowned; file touched by #415 (verify the use is covered)                |
| `services/lifecycle-emails.service.ts:109,132`                     | Store | yes           | unowned                                                                  |
| `services/locations.service.ts:58`                                 | Store | yes           | unowned                                                                  |
| `services/loyalty-automation.service.ts:106`                       | Store | no            | unowned                                                                  |
| `services/loyalty.service.ts:173,206,259,308,409,600 (+4)`         | Store | yes           | unowned                                                                  |
| `services/notification-dispatcher.service.ts:354,390`              | Store | yes           | unowned                                                                  |
| `services/onboarding.service.ts:105,199,253,390`                   | Store | yes           | unowned; file touched by #408 (verify the use is covered)                |
| `services/order.service.ts:1310,2554,4173`                         | Store | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/page-builder.service.ts:162,580,642,677`                 | Store | yes           | unowned; file touched by #410 (verify the use is covered)                |
| `services/payment-confirm.service.ts:207`                          | Store | no            | unowned                                                                  |
| `services/payment-providers/instapay.service.ts:1167`              | Store | yes           | unowned                                                                  |
| `services/payment-providers/payment.factory.ts:1090`               | Store | yes           | unowned                                                                  |
| `services/plan-entitlements.ts:102`                                | Store | no            | unowned; file touched by #408 (verify the use is covered)                |
| `services/plan-limit.service.ts:98,166,275,326,379`                | Store | yes           | unowned; file touched by #408/#410/#414 (verify the use is covered)      |
| `services/plan.service.ts:157`                                     | Store | yes           | unowned                                                                  |
| `services/product.service.ts:475,670,2608`                         | Store | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/provider-activation.service.ts:446`                      | Store | no            | unowned                                                                  |
| `services/provider-verification.service.ts:121`                    | Store | no            | unowned                                                                  |
| `services/provisioning.service.ts:309,506,517`                     | Store | yes           | unowned; file touched by #408 (verify the use is covered)                |
| `services/pwa.service.ts:323,362,421,547,585`                      | Store | yes           | unowned                                                                  |
| `services/qr.service.ts:47`                                        | Store | yes           | unowned; file touched by #416 (verify the use is covered)                |
| `services/return.service.ts:312,352`                               | Store | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/setup-guide.service.ts:57,99`                            | Store | yes           | unowned; file touched by #408 (verify the use is covered)                |
| `services/shipping-carrier.service.ts:559`                         | Store | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/socket.service.ts:264`                                   | Store | no            | unowned                                                                  |
| `services/store-closure.service.ts:193`                            | Store | no            | unowned; file touched by #407/#410/#415/#416 (verify the use is covered) |
| `services/store-contact.service.ts:20`                             | Store | no            | unowned                                                                  |
| `services/store-creation-limit.ts:25`                              | Store | no            | unowned; file touched by #408 (verify the use is covered)                |
| `services/store-mailer.service.ts:21,105`                          | Store | no            | unowned                                                                  |
| `services/store.service.ts:216,306,403,414,462,477 (+18)`          | Store | yes           | unowned; file touched by #408 (verify the use is covered)                |
| `services/tax.service.ts:52`                                       | Store | yes           | unowned                                                                  |

## B. Identity models through Postgres

#414 moves CUSTOMER auth (users with a store) into the StoreDO; the ADMIN namespace (store owners, staff, super-admins, passkeys) is the identity service `ebda-accounts` (N-8, unowned in this chain).

| file:line                                                      | model             | DO-aware file | owner                                                                    |
| -------------------------------------------------------------- | ----------------- | ------------- | ------------------------------------------------------------------------ |
| `lib/ci/source.ts:319`                                         | User              | yes           | unowned                                                                  |
| `lib/inngest/functions/data-retention.ts:188`                  | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `lib/inngest/functions/ebda-ads-conversion.ts:44`              | User              | no            | unowned                                                                  |
| `lib/inngest/functions/order-created.ts:11`                    | User              | yes           | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:8`                    | User              | yes           | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-status-changed.ts:8`              | User              | yes           | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/wa-store-events.ts:247`                 | User              | no            | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/jobs/store-db.ts:161`                                     | User              | yes           | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/store-customer.ts:40`                                     | User              | no            | unowned; file touched by #414 (verify the use is covered)                |
| `lib/store-members.ts:56`                                      | User              | no            | unowned; file touched by #410 (verify the use is covered)                |
| `lib/wa/consent.ts:219,263`                                    | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `middleware/require-mfa.ts:30`                                 | User              | no            | unowned                                                                  |
| `middleware/require-verified-email.ts:23`                      | User              | no            | unowned                                                                  |
| `routes/admin-search.routes.ts:144`                            | User              | yes           | unowned                                                                  |
| `routes/admin.routes.ts:932,952,1004,1036,1091,1153 (+8)`      | User              | yes           | unowned; file touched by #408/#410/#414/#416 (verify the use is covered) |
| `routes/auth.routes.ts:880,883`                                | User              | no            | unowned; file touched by #408/#414 (verify the use is covered)           |
| `routes/campaign.routes.ts:561`                                | User              | yes           | unowned                                                                  |
| `routes/customers.routes.ts:734`                               | User              | no            | unowned; file touched by #414 (verify the use is covered)                |
| `routes/feature.routes.ts:60`                                  | User              | no            | unowned                                                                  |
| `routes/mfa.routes.ts:78,97,133,146,227,243 (+2)`              | User              | no            | unowned                                                                  |
| `routes/shipping-carrier.routes.ts:773`                        | User              | yes           | unowned; file touched by #408/#414 (verify the use is covered)           |
| `routes/sms-consent.routes.ts:57`                              | User              | no            | unowned; file touched by #414 (verify the use is covered)                |
| `routes/staff.routes.ts:225,390`                               | User              | no            | unowned; file touched by #408/#410 (verify the use is covered)           |
| `routes/wallet.routes.ts:54`                                   | User              | no            | unowned; file touched by #414 (verify the use is covered)                |
| `services/abandoned-cart.service.ts:944`                       | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/accounting/assert-store-owns.ts:105`                 | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/analytics.service.ts:790,805,842`                    | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:1669,2019,2952`                      | PasskeyCredential | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:1056,1071,1159,1167,1201,1308 (+13)` | RefreshToken      | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:185,422,514,668,711,1215 (+13)`      | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:570,590,649,689,715,795`             | VerificationToken | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/customer-aggregate.service.ts:500,725`               | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/customer-group.service.ts:223,349`                   | User              | no            | unowned; file touched by #414 (verify the use is covered)                |
| `services/customer-search.service.ts:22`                       | User              | no            | unowned; file touched by #414 (verify the use is covered)                |
| `services/identity-shadow.ts:17,19,31`                         | User              | no            | unowned                                                                  |
| `services/legal-notice.service.ts:236,402,584,883`             | User              | no            | unowned; file touched by #415 (verify the use is covered)                |
| `services/lifecycle-emails.service.ts:296`                     | User              | yes           | unowned                                                                  |
| `services/merchant-signup.service.ts:94,116,179`               | User              | no            | unowned                                                                  |
| `services/onboarding.service.ts:97,188`                        | User              | yes           | unowned; file touched by #408 (verify the use is covered)                |
| `services/order.service.ts:500,4046`                           | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/passkey.service.ts:436,525,723,764,795,818 (+1)`     | PasskeyCredential | no            | unowned; file touched by #414 (verify the use is covered)                |
| `services/passkey.service.ts:293,349,414,651`                  | User              | no            | unowned; file touched by #414 (verify the use is covered)                |
| `services/price-resolver.service.ts:216,244`                   | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/product.service.ts:2378`                             | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/return.service.ts:264,346`                           | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/shipping-carrier.service.ts:486,1395`                | User              | yes           | unowned; file touched by #414 (verify the use is covered)                |
| `services/store.service.ts:720,1078,1096`                      | User              | yes           | unowned; file touched by #408 (verify the use is covered)                |
| `services/wholesale-application.service.ts:77,297,332`         | User              | no            | unowned; file touched by #414 (verify the use is covered)                |

## C. Store-DO models through the Postgres client in files with NO DO branch (a DO store hits Postgres here)

| file:line                                                                     | model                 | owner                                                                    |
| ----------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `lib/guest-checkout.ts:18`                                                    | Order                 | unowned                                                                  |
| `lib/inngest/functions/queue-depth-watch.ts:191,254`                          | BulkAiJob             | unowned; file touched by #416 (verify the use is covered)                |
| `lib/order-tax.ts:58`                                                         | StoreTaxProfile       | unowned                                                                  |
| `lib/order-tax.ts:54`                                                         | TaxRate               | unowned                                                                  |
| `lib/wa/link.ts:106,146,151,157`                                              | StoreWhatsAppLink     | unowned                                                                  |
| `lib/wa/store-events-consumer.ts:42`                                          | Order                 | unowned                                                                  |
| `mcp/agent-auth.ts:663,694`                                                   | AuditLog              | unowned                                                                  |
| `mcp/agent-auth.ts:222`                                                       | StoreCredential       | unowned                                                                  |
| `mcp/tools/order.tools.ts:202`                                                | Payment               | unowned                                                                  |
| `mcp/tools/order.tools.ts:124`                                                | PaymentConfig         | unowned                                                                  |
| `routes/address.routes.ts:61,97,104,107,149,184 (+5)`                         | Address               | unowned                                                                  |
| `routes/affiliate.routes.ts:318`                                              | AffiliatePayout       | unowned; file touched by #408 (verify the use is covered)                |
| `routes/affiliate.routes.ts:312`                                              | AffiliateReferral     | unowned; file touched by #408 (verify the use is covered)                |
| `routes/finance.routes.ts:1337,1353,1376,1422,1459,1528 (+2)`                 | BankStatement         | unowned                                                                  |
| `routes/finance.routes.ts:1478,1504`                                          | BankTransaction       | unowned                                                                  |
| `routes/finance.routes.ts:1138,1177`                                          | FxRateEntry           | unowned                                                                  |
| `routes/finance.routes.ts:161,174,209`                                        | JournalEntry          | unowned                                                                  |
| `routes/loyalty.routes.ts:254,264`                                            | LoyaltyTransaction    | unowned                                                                  |
| `routes/notification.routes.ts:378,379,427,428`                               | NotificationLog       | unowned; file touched by #416 (verify the use is covered)                |
| `routes/order.routes.ts:2351`                                                 | AuditLog              | unowned                                                                  |
| `routes/order.routes.ts:192,911,965,1239,1267,1370 (+5)`                      | Order                 | unowned                                                                  |
| `routes/order.routes.ts:961,1263,1491,1565,1676`                              | Payment               | unowned                                                                  |
| `routes/payment-abandonments.routes.ts:107,150,235,238,248,258`               | Order                 | unowned                                                                  |
| `routes/payment-settings.routes.ts:287,360,377,398,496,513 (+11)`             | PaymentConfig         | unowned; file touched by #408 (verify the use is covered)                |
| `routes/payment.routes.ts:345,1139,1149,1387,1391,1396`                       | Order                 | unowned; file touched by #408/#410 (verify the use is covered)           |
| `routes/payment.routes.ts:374,628,682,1202,1258,1330`                         | Payment               | unowned; file touched by #408/#410 (verify the use is covered)           |
| `routes/payment.routes.ts:201,592`                                            | PaymentConfig         | unowned; file touched by #408/#410 (verify the use is covered)           |
| `routes/payment.routes.ts:1471,1522`                                          | PaymentEvent          | unowned; file touched by #408/#410 (verify the use is covered)           |
| `routes/product-model.routes.ts:186,308,346,371`                              | ProductModel          | unowned                                                                  |
| `routes/review.routes.ts:454`                                                 | Review                | unowned                                                                  |
| `routes/shipping.routes.ts:85,115,666,701,831,887 (+3)`                       | ShippingAreaRate      | unowned                                                                  |
| `services/accounting/backorder-stock-heal.ts:54`                              | InventoryHistory      | unowned                                                                  |
| `services/accounting/backorder-stock-heal.ts:50`                              | Product               | unowned                                                                  |
| `services/accounting/backorder.service.ts:18,91,124,132,139`                  | BackorderLine         | unowned                                                                  |
| `services/accounting/backorder.service.ts:194`                                | Order                 | unowned                                                                  |
| `services/accounting/backorder.service.ts:171`                                | OrderEvent            | unowned                                                                  |
| `services/accounting/backorder.service.ts:150`                                | OrderItem             | unowned                                                                  |
| `services/accounting/bank-reconcile.service.ts:177,412,544,641`               | BankStatement         | unowned                                                                  |
| `services/accounting/bank-reconcile.service.ts:193,282,288,303,381,400 (+10)` | BankTransaction       | unowned                                                                  |
| `services/accounting/bank-reconcile.service.ts:489`                           | JournalEntry          | unowned                                                                  |
| `services/accounting/bank-reconcile.service.ts:342`                           | JournalLine           | unowned                                                                  |
| `services/accounting/journal.service.ts:87,156,160,176,185`                   | JournalEntry          | unowned                                                                  |
| `services/accounting/posting/prior-reversed-qty.ts:91`                        | OrderEvent            | unowned                                                                  |
| `services/accounting/posting/prior-reversed-qty.ts:55`                        | Return                | unowned                                                                  |
| `services/accounting/supplier.service.ts:22,76,81,94,105,109 (+1)`            | Supplier              | unowned                                                                  |
| `services/affiliate-event.service.ts:105,137`                                 | AffiliateEvent        | unowned                                                                  |
| `services/answer-engine/gsc-dashboard.service.ts:132`                         | GscDailyMetric        | unowned; file touched by #416 (verify the use is covered)                |
| `services/bundle.service.ts:205,391,503`                                      | Bundle                | unowned                                                                  |
| `services/bundle.service.ts:418`                                              | BundleItem            | unowned                                                                  |
| `services/coupon.service.ts:97,103,118,130,170,181 (+5)`                      | Coupon                | unowned                                                                  |
| `services/customer-group.service.ts:180,195,234,240,246,251 (+15)`            | Customer              | unowned; file touched by #414 (verify the use is covered)                |
| `services/customer-group.service.ts:58,74,87,94,116,123 (+7)`                 | CustomerGroup         | unowned; file touched by #414 (verify the use is covered)                |
| `services/gold-rate/repricer.ts:238,263`                                      | Product               | unowned                                                                  |
| `services/loyalty-automation.service.ts:145,223,371,405`                      | LoyaltyPoints         | unowned                                                                  |
| `services/loyalty-automation.service.ts:194,230,302,397,412,422`              | LoyaltyTransaction    | unowned                                                                  |
| `services/onboarding-instapay.ts:31,38,69,74`                                 | PaymentConfig         | unowned                                                                  |
| `services/onesignal.service.ts:1028,1038,1047`                                | OneSignalSubscription | unowned                                                                  |
| `services/packing-slip.service.ts:84`                                         | Order                 | unowned                                                                  |
| `services/payment-confirm.service.ts:240,259,344`                             | Order                 | unowned                                                                  |
| `services/payment-confirm.service.ts:273,415`                                 | Payment               | unowned                                                                  |
| `services/payment-providers/cod.provider.ts:37`                               | PaymentConfig         | unowned                                                                  |
| `services/payment-providers/provider-health.ts:120`                           | PaymentConfig         | unowned                                                                  |
| `services/payment-providers/refund-settle.ts:90,267,338,451`                  | Payment               | unowned                                                                  |
| `services/payment-providers/refund-settle.ts:116,158,273,317,349,411 (+2)`    | PaymentEvent          | unowned                                                                  |
| `services/payment-state-claims.ts:27,37,47,77,82`                             | Order                 | unowned                                                                  |
| `services/promotion-resolver.ts:36,45`                                        | Order                 | unowned                                                                  |
| `services/promotion-resolver.ts:71`                                           | Promotion             | unowned                                                                  |
| `services/promotion.service.ts:58,64,79,93,129,158 (+1)`                      | Promotion             | unowned                                                                  |
| `services/provider-activation.service.ts:114,307,314`                         | PaymentConfig         | unowned                                                                  |
| `services/provider-activation.service.ts:118`                                 | ShippingCarrierConfig | unowned                                                                  |
| `services/provider-verification.service.ts:100`                               | PaymentConfig         | unowned                                                                  |
| `services/provider-verification.service.ts:106`                               | ShippingCarrierConfig | unowned                                                                  |
| `services/push.service.ts:175,350`                                            | NotificationLog       | unowned; file touched by #416 (verify the use is covered)                |
| `services/push.service.ts:90,147,199,282,328,365 (+1)`                        | PushSubscription      | unowned; file touched by #416 (verify the use is covered)                |
| `services/shipping.service.ts:291`                                            | ShippingAreaRate      | unowned                                                                  |
| `services/shipping.service.ts:142,148,163,176,181,204 (+6)`                   | ShippingZone          | unowned                                                                  |
| `services/sms-consent.service.ts:128,149,176,197`                             | SmsMarketingConsent   | unowned                                                                  |
| `services/sms-queue.service.ts:18,29,260`                                     | NotificationLog       | unowned; file touched by #416 (verify the use is covered)                |
| `services/store-closure.service.ts:198`                                       | FiscalDocument        | unowned; file touched by #407/#410/#415/#416 (verify the use is covered) |
| `services/wholesale-application.service.ts:91,186`                            | Customer              | unowned; file touched by #414 (verify the use is covered)                |
| `services/wholesale-application.service.ts:262`                               | CustomerGroup         | unowned; file touched by #414 (verify the use is covered)                |
| `services/wholesale-application.service.ts:98,127,144,174,198,229 (+12)`      | WholesaleApplication  | unowned; file touched by #414 (verify the use is covered)                |

## D. Store-DO models through the Postgres client in DO-aware files (a branch exists; N-15 must prove each)

| file:line                                                                            | model                   | owner                                                                    |
| ------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------ |
| `lib/ci/source.ts:272`                                                               | Order                   | unowned                                                                  |
| `lib/inngest/functions/accounting-period-reconciliation.ts:54`                       | Order                   | unowned                                                                  |
| `lib/inngest/functions/data-retention.ts:316,347`                                    | Order                   | unowned; file touched by #414 (verify the use is covered)                |
| `lib/inngest/functions/order-created.ts:80,110`                                      | Order                   | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:406,546,730,747,767`                        | BackorderLine           | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:643`                                        | Coupon                  | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:371,475,619`                                | InventoryHistory        | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:219,1227`                                   | Order                   | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:391,423,461,490,500,611 (+11)`              | OrderEvent              | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:366`                                        | Product                 | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:358`                                        | ProductVariant          | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-refunded.ts:1219`                                       | Return                  | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-status-changed.ts:76,105,340`                           | Order                   | unowned; file touched by #414/#416 (verify the use is covered)           |
| `lib/inngest/functions/order-status-fanout-stuck-sweep.ts:166`                       | Order                   | unowned                                                                  |
| `lib/inngest/functions/payment-abandonment-sweep.ts:166`                             | Order                   | unowned                                                                  |
| `lib/inngest/functions/payment-webhook-process.ts:144,165`                           | Order                   | unowned                                                                  |
| `lib/inngest/functions/review-request.ts:187`                                        | Order                   | unowned; file touched by #416 (verify the use is covered)                |
| `lib/wa/consent.ts:44`                                                               | Order                   | unowned; file touched by #414 (verify the use is covered)                |
| `lib/wa/consent.ts:71,76,97,151,233,299 (+8)`                                        | StoreWhatsAppConsent    | unowned; file touched by #414 (verify the use is covered)                |
| `mcp/tools/admin-read.tools.ts:350`                                                  | OrderEvent              | unowned                                                                  |
| `routes/admin.routes.ts:1841,1857`                                                   | Customer                | unowned; file touched by #408/#410/#414/#416 (verify the use is covered) |
| `routes/admin.routes.ts:1543,1544,1568,1775,1785,2407 (+1)`                          | Order                   | unowned; file touched by #408/#410/#414/#416 (verify the use is covered) |
| `routes/admin.routes.ts:1650,1659,1700`                                              | Product                 | unowned; file touched by #408/#410/#414/#416 (verify the use is covered) |
| `routes/analytics.routes.ts:320`                                                     | BackorderLine           | unowned; file touched by #408 (verify the use is covered)                |
| `routes/analytics.routes.ts:333`                                                     | ReorderRule             | unowned; file touched by #408 (verify the use is covered)                |
| `routes/bundle.routes.ts:410,417,519,569,609,695 (+3)`                               | Bundle                  | unowned                                                                  |
| `routes/bundle.routes.ts:451,898`                                                    | BundleItem              | unowned                                                                  |
| `routes/insights.routes.ts:159,174`                                                  | Order                   | unowned                                                                  |
| `routes/insights.routes.ts:209,514,527`                                              | OrderItem               | unowned                                                                  |
| `routes/public.routes.ts:1605,2688,2776`                                             | Order                   | unowned                                                                  |
| `routes/public.routes.ts:2799`                                                       | OrderItem               | unowned                                                                  |
| `routes/public.routes.ts:2809`                                                       | Review                  | unowned                                                                  |
| `routes/public.routes.ts:1869`                                                       | Wishlist                | unowned                                                                  |
| `routes/return.routes.ts:608`                                                        | AuditLog                | unowned                                                                  |
| `routes/shipping-carrier.routes.ts:848`                                              | Order                   | unowned; file touched by #408/#414 (verify the use is covered)           |
| `routes/smart-layer.routes.ts:242`                                                   | DeadStockFlag           | unowned                                                                  |
| `routes/smart-layer.routes.ts:78,90,132`                                             | ReorderSuggestion       | unowned                                                                  |
| `routes/webhook.routes.ts:344`                                                       | Order                   | unowned                                                                  |
| `routes/wishlist.routes.ts:79,104,190,195,361,366 (+2)`                              | Wishlist                | unowned                                                                  |
| `routes/wishlist.routes.ts:201,217,269,292,316,411`                                  | WishlistItem            | unowned                                                                  |
| `services/abandoned-cart.service.ts:385,607,756`                                     | AbandonedCart           | unowned; file touched by #414 (verify the use is covered)                |
| `services/abandoned-cart.service.ts:978`                                             | Cart                    | unowned; file touched by #414 (verify the use is covered)                |
| `services/abandoned-cart.service.ts:585`                                             | Coupon                  | unowned; file touched by #414 (verify the use is covered)                |
| `services/accounting/account.service.ts:20,28,175,207,261,269 (+4)`                  | Account                 | unowned                                                                  |
| `services/accounting/account.service.ts:87`                                          | Product                 | unowned                                                                  |
| `services/accounting/account.service.ts:103`                                         | ProductVariant          | unowned                                                                  |
| `services/accounting/analytics-rollup.service.ts:508`                                | ProductDailyView        | unowned; file touched by #416 (verify the use is covered)                |
| `services/accounting/assert-store-owns.ts:98`                                        | Account                 | unowned; file touched by #414 (verify the use is covered)                |
| `services/accounting/assert-store-owns.ts:108`                                       | Category                | unowned; file touched by #414 (verify the use is covered)                |
| `services/accounting/assert-store-owns.ts:79`                                        | Product                 | unowned; file touched by #414 (verify the use is covered)                |
| `services/accounting/assert-store-owns.ts:85`                                        | ProductVariant          | unowned; file touched by #414 (verify the use is covered)                |
| `services/accounting/assert-store-owns.ts:92`                                        | Supplier                | unowned; file touched by #414 (verify the use is covered)                |
| `services/accounting/deadstock-scan.service.ts:536`                                  | Coupon                  | unowned                                                                  |
| `services/accounting/deadstock-scan.service.ts:435,458,463,548`                      | DeadStockFlag           | unowned                                                                  |
| `services/accounting/deadstock-scan.service.ts:264`                                  | Product                 | unowned                                                                  |
| `services/accounting/expense-ocr.service.ts:272`                                     | Expense                 | unowned                                                                  |
| `services/accounting/expense.service.ts:190`                                         | Account                 | unowned                                                                  |
| `services/accounting/expense.service.ts:251,347,361,387,394,427 (+1)`                | Expense                 | unowned                                                                  |
| `services/accounting/posting/expense-posting.ts:33`                                  | Expense                 | unowned                                                                  |
| `services/accounting/posting/order-posting.ts:74`                                    | Order                   | unowned                                                                  |
| `services/accounting/posting/partial-return-posting.ts:152,163,182,192,548,564 (+1)` | JournalEntry            | unowned                                                                  |
| `services/accounting/posting/partial-return-posting.ts:116,533`                      | Order                   | unowned                                                                  |
| `services/accounting/posting/partial-return-posting.ts:451`                          | Return                  | unowned                                                                  |
| `services/accounting/posting/partial-return-posting.ts:233`                          | ReturnItem              | unowned                                                                  |
| `services/accounting/posting/partial-return-posting.ts:456`                          | WalletTransaction       | unowned                                                                  |
| `services/accounting/posting/po-receive-posting.ts:45`                               | PurchaseOrder           | unowned                                                                  |
| `services/accounting/posting/refund-posting.ts:64`                                   | JournalEntry            | unowned                                                                  |
| `services/accounting/posting/stock-adjustment-posting.ts:48`                         | StockAdjustment         | unowned                                                                  |
| `services/accounting/purchase-order.service.ts:303,322,360`                          | BackorderLine           | unowned                                                                  |
| `services/accounting/purchase-order.service.ts:477`                                  | InventoryHistory        | unowned                                                                  |
| `services/accounting/purchase-order.service.ts:371`                                  | OrderItem               | unowned                                                                  |
| `services/accounting/purchase-order.service.ts:383,446,462`                          | Product                 | unowned                                                                  |
| `services/accounting/purchase-order.service.ts:116,148,289,406,437`                  | ProductVariant          | unowned                                                                  |
| `services/accounting/purchase-order.service.ts:77,243,504,585,589,599`               | PurchaseOrder           | unowned                                                                  |
| `services/accounting/purchase-order.service.ts:492,499`                              | PurchaseOrderItem       | unowned                                                                  |
| `services/accounting/purchase-order.service.ts:678`                                  | ReorderSuggestion       | unowned                                                                  |
| `services/accounting/reorder-scan.service.ts:511`                                    | BackorderLine           | unowned                                                                  |
| `services/accounting/reorder-scan.service.ts:150`                                    | OrderItem               | unowned                                                                  |
| `services/accounting/reorder-scan.service.ts:323`                                    | Product                 | unowned                                                                  |
| `services/accounting/reorder-scan.service.ts:108,494`                                | PurchaseOrderItem       | unowned                                                                  |
| `services/accounting/reorder-scan.service.ts:671,697,702`                            | ReorderSuggestion       | unowned                                                                  |
| `services/accounting/reorder-scan.service.ts:126`                                    | Supplier                | unowned                                                                  |
| `services/accounting/stock-adjustment.service.ts:263`                                | InventoryHistory        | unowned                                                                  |
| `services/accounting/stock-adjustment.service.ts:122,252`                            | Product                 | unowned                                                                  |
| `services/accounting/stock-adjustment.service.ts:116,244`                            | ProductVariant          | unowned                                                                  |
| `services/accounting/stock-adjustment.service.ts:151,212,231`                        | StockAdjustment         | unowned                                                                  |
| `services/accounting/stock-adjustment.service.ts:298`                                | Warehouse               | unowned                                                                  |
| `services/affiliate.service.ts:163,184,195,229,238,282 (+11)`                        | Affiliate               | unowned                                                                  |
| `services/affiliate.service.ts:128`                                                  | AffiliateConfig         | unowned                                                                  |
| `services/affiliate.service.ts:697,703`                                              | AffiliatePayout         | unowned                                                                  |
| `services/affiliate.service.ts:436,459,478,603,670,676 (+2)`                         | AffiliateReferral       | unowned                                                                  |
| `services/analytics.service.ts:409,756,821,874,953`                                  | Order                   | unowned; file touched by #414 (verify the use is covered)                |
| `services/analytics.service.ts:577,623,692`                                          | OrderItem               | unowned; file touched by #414 (verify the use is covered)                |
| `services/analytics.service.ts:1016`                                                 | ReorderRule             | unowned; file touched by #414 (verify the use is covered)                |
| `services/answer-engine/gsc-ingest.service.ts:162`                                   | GscDailyMetric          | unowned; file touched by #416 (verify the use is covered)                |
| `services/auth.service.ts:2341`                                                      | AbandonedCart           | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2906`                                                      | Address                 | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2513,2522,2533`                                            | CampaignRecipient       | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2342`                                                      | Cart                    | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2360,2423,2439,2478`                                       | Customer                | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2469`                                                      | CustomerAddress         | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2920`                                                      | CustomerWallet          | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2355,2917`                                                 | LoyaltyPoints           | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2352,2918`                                                 | LoyaltyTransaction      | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2536`                                                      | NewsletterSubscriber    | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2216,2944`                                                 | OneSignalSubscription   | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2266,2276,2303,2907`                                       | Order                   | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2344,2939`                                                 | PushSubscription        | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2916`                                                      | Return                  | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2319`                                                      | Review                  | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2560,2968`                                                 | SmsMarketingConsent     | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2924`                                                      | WalletTransaction       | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2359,2983`                                                 | WholesaleApplication    | unowned; file touched by #414 (verify the use is covered)                |
| `services/auth.service.ts:2343,2914`                                                 | Wishlist                | unowned; file touched by #414 (verify the use is covered)                |
| `services/barcode-scan.service.ts:512,522,538`                                       | CountLine               | unowned                                                                  |
| `services/barcode-scan.service.ts:454,485,567,575,625,642 (+2)`                      | CountSession            | unowned                                                                  |
| `services/barcode-scan.service.ts:217`                                               | InventoryHistory        | unowned                                                                  |
| `services/barcode-scan.service.ts:849`                                               | Order                   | unowned                                                                  |
| `services/barcode-scan.service.ts:334`                                               | OrderItem               | unowned                                                                  |
| `services/barcode-scan.service.ts:502`                                               | Product                 | unowned                                                                  |
| `services/barcode-scan.service.ts:205,213,496`                                       | ProductVariant          | unowned                                                                  |
| `services/barcode.service.ts:198,215,226`                                            | Product                 | unowned                                                                  |
| `services/barcode.service.ts:204,221,229`                                            | ProductVariant          | unowned                                                                  |
| `services/bulk.service.ts:1448`                                                      | InventoryHistory        | unowned                                                                  |
| `services/bulk.service.ts:359,1403,1407,1437`                                        | Product                 | unowned                                                                  |
| `services/bulk.service.ts:1472,1484`                                                 | ProductCategory         | unowned                                                                  |
| `services/bulk.service.ts:1519,1522`                                                 | ProductImage            | unowned                                                                  |
| `services/bulk.service.ts:191,240`                                                   | ProductOption           | unowned                                                                  |
| `services/bulk.service.ts:1498,1508`                                                 | ProductTag              | unowned                                                                  |
| `services/bulk.service.ts:208,235`                                                   | ProductVariant          | unowned                                                                  |
| `services/bulk.service.ts:355`                                                       | ProductVariantOption    | unowned                                                                  |
| `services/cart.service.ts:845,855,860`                                               | CartBundle              | unowned                                                                  |
| `services/cart.service.ts:615,641,661,1081,1123,1135`                                | CartItem                | unowned                                                                  |
| `services/cart.service.ts:542`                                                       | Product                 | unowned                                                                  |
| `services/cart.service.ts:593`                                                       | ProductVariant          | unowned                                                                  |
| `services/cod-reconciliation.service.ts:123`                                         | CodRemittance           | unowned                                                                  |
| `services/customer-aggregate.service.ts:767,875,884`                                 | Customer                | unowned; file touched by #414 (verify the use is covered)                |
| `services/customer-aggregate.service.ts:287,668`                                     | Order                   | unowned; file touched by #414 (verify the use is covered)                |
| `services/customer-reorder.service.ts:32`                                            | Order                   | unowned                                                                  |
| `services/fiscal-document.service.ts:313,401,455,460,483,487 (+2)`                   | FiscalDocument          | unowned                                                                  |
| `services/fiscal-document.service.ts:318`                                            | Order                   | unowned                                                                  |
| `services/gold-rate/gold-rate.service.ts:616`                                        | BundleItem              | unowned                                                                  |
| `services/gold-rate/gold-rate.service.ts:83,145,261,266,365,377 (+1)`                | GoldRate                | unowned                                                                  |
| `services/gold-rate/gold-rate.service.ts:556,594,606,648,691,792`                    | Product                 | unowned                                                                  |
| `services/gold-rate/gold-rate.service.ts:624`                                        | ProductPriceTier        | unowned                                                                  |
| `services/gold-rate/gold-rate.service.ts:598,664,669`                                | ProductVariant          | unowned                                                                  |
| `services/inventory.service.ts:369,583,692,783,789,839 (+3)`                         | InventoryHistory        | unowned                                                                  |
| `services/inventory.service.ts:319,354,526,578,664,677 (+4)`                         | Product                 | unowned                                                                  |
| `services/inventory.service.ts:334`                                                  | ProductVariant          | unowned                                                                  |
| `services/inventory.service.ts:989`                                                  | WishlistItem            | unowned                                                                  |
| `services/loyalty.service.ts:253,334,347,429,437,485 (+25)`                          | LoyaltyPoints           | unowned                                                                  |
| `services/loyalty.service.ts:359,461,493,511,579,588 (+14)`                          | LoyaltyTransaction      | unowned                                                                  |
| `services/notification-config.service.ts:93`                                         | NotificationConfig      | unowned                                                                  |
| `services/notification-dispatcher.service.ts:199`                                    | NotificationEventConfig | unowned                                                                  |
| `services/onboarding.service.ts:130,347,351,362,367,403`                             | PaymentConfig           | unowned; file touched by #408 (verify the use is covered)                |
| `services/order.service.ts:2339,2353`                                                | AbandonedCart           | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:2274`                                                     | BackorderLine           | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:2914`                                                     | Bundle                  | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:1144`                                                     | BundleItem              | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:2878,2884`                                                | Cart                    | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:1718,2324,2891,2926`                                      | CartBundle              | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:1714,2323,2890,2923`                                      | CartItem                | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:2056,2844,4330,4461`                                      | Coupon                  | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:3409`                                                     | Customer                | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:2261,2827`                                                | InventoryHistory        | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:737,1701,2073,2774,2952,3073 (+4)`                        | Order                   | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:2856,3135,4541,4561`                                      | OrderEvent              | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:2284`                                                     | OrderItem               | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:3100,3733,3743`                                           | Payment                 | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:971,1892,2791,2806,4085`                                  | Product                 | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:1897,2799`                                                | ProductVariant          | unowned; file touched by #414 (verify the use is covered)                |
| `services/order.service.ts:3673`                                                     | Return                  | unowned; file touched by #414 (verify the use is covered)                |
| `services/payment-event.service.ts:126`                                              | Payment                 | unowned                                                                  |
| `services/payment-event.service.ts:58`                                               | PaymentEvent            | unowned                                                                  |
| `services/payment-providers/instapay-receipt.service.ts:546`                         | Payment                 | unowned                                                                  |
| `services/payment-providers/instapay.service.ts:237,513,581,664,669,704 (+4)`        | Order                   | unowned                                                                  |
| `services/payment-providers/instapay.service.ts:266,546`                             | OrderEvent              | unowned                                                                  |
| `services/payment-providers/instapay.service.ts:197,245,471,492,521,656 (+8)`        | Payment                 | unowned                                                                  |
| `services/payment-providers/instapay.service.ts:148`                                 | PaymentConfig           | unowned                                                                  |
| `services/payment-providers/payment.factory.ts:540,1561,1656,1985,2354,2415`         | Order                   | unowned                                                                  |
| `services/payment-providers/payment.factory.ts:531,829,933,985,1180,1327 (+6)`       | Payment                 | unowned                                                                  |
| `services/payment-providers/payment.factory.ts:192`                                  | PaymentConfig           | unowned                                                                  |
| `services/payment-providers/payment.factory.ts:590,627,657,1364,1452,1494 (+2)`      | PaymentEvent            | unowned                                                                  |
| `services/price-tier.service.ts:95`                                                  | CustomerGroup           | unowned                                                                  |
| `services/product-model.service.ts:109,161,178,186,207,212 (+1)`                     | ProductModel            | unowned                                                                  |
| `services/product-model.service.ts:188,268,270`                                      | ProductModelBinding     | unowned                                                                  |
| `services/product.service.ts:602`                                                    | OrderItem               | unowned; file touched by #414 (verify the use is covered)                |
| `services/product.service.ts:1131,1294,1514,1523`                                    | Product                 | unowned; file touched by #414 (verify the use is covered)                |
| `services/product.service.ts:1112,1119,1121`                                         | ProductCategory         | unowned; file touched by #414 (verify the use is covered)                |
| `services/product.service.ts:1091,1093`                                              | ProductImage            | unowned; file touched by #414 (verify the use is covered)                |
| `services/provisioning.service.ts:366`                                               | Category                | unowned; file touched by #408 (verify the use is covered)                |
| `services/provisioning.service.ts:525,559,566`                                       | Order                   | unowned; file touched by #408 (verify the use is covered)                |
| `services/provisioning.service.ts:381`                                               | PaymentConfig           | unowned; file touched by #408 (verify the use is covered)                |
| `services/provisioning.service.ts:355`                                               | TaxRate                 | unowned; file touched by #408 (verify the use is covered)                |
| `services/return.service.ts:539`                                                     | Order                   | unowned; file touched by #414 (verify the use is covered)                |
| `services/return.service.ts:1058`                                                    | OrderItem               | unowned; file touched by #414 (verify the use is covered)                |
| `services/return.service.ts:668,760,877,1023,1293,2283`                              | Return                  | unowned; file touched by #414 (verify the use is covered)                |
| `services/return.service.ts:1314`                                                    | ReturnItem              | unowned; file touched by #414 (verify the use is covered)                |
| `services/shipment-pickup.service.ts:52,88,169,192,227,242 (+6)`                     | ShipmentPickup          | unowned                                                                  |
| `services/shipping-carrier.service.ts:1025`                                          | Payment                 | unowned; file touched by #414 (verify the use is covered)                |
| `services/shipping-carrier.service.ts:207,283,288,312,317,331 (+6)`                  | ShippingCarrierConfig   | unowned; file touched by #414 (verify the use is covered)                |
| `services/store.service.ts:1241`                                                     | Customer                | unowned; file touched by #408 (verify the use is covered)                |
| `services/store.service.ts:279,424,1240,1242,1252`                                   | Order                   | unowned; file touched by #408 (verify the use is covered)                |
| `services/store.service.ts:702`                                                      | TaxRate                 | unowned; file touched by #408 (verify the use is covered)                |
| `services/tax-profile.service.ts:203,225,263,268,292`                                | StoreTaxDocument        | unowned                                                                  |
| `services/tax-profile.service.ts:139,144,152,166,302,328 (+3)`                       | StoreTaxProfile         | unowned                                                                  |
| `services/tax.service.ts:122,139,157,180,202,212`                                    | TaxRate                 | unowned                                                                  |
| `services/variant.service.ts:704`                                                    | InventoryHistory        | unowned                                                                  |
| `services/variant.service.ts:902`                                                    | Product                 | unowned                                                                  |
| `services/variant.service.ts:920,924`                                                | ProductVariant          | unowned                                                                  |
| `services/wallet.service.ts:291,334,349,592`                                         | CustomerWallet          | unowned; file touched by #414 (verify the use is covered)                |
| `services/wallet.service.ts:305,572,583,604`                                         | WalletTransaction       | unowned; file touched by #414 (verify the use is covered)                |
| `services/warehouse.service.ts:638`                                                  | InventoryHistory        | unowned                                                                  |
| `services/warehouse.service.ts:536,600`                                              | Product                 | unowned                                                                  |
| `services/warehouse.service.ts:678`                                                  | ProductVariant          | unowned                                                                  |
| `services/warehouse.service.ts:170,204,228,241,247,287 (+14)`                        | Warehouse               | unowned                                                                  |
| `services/warehouse.service.ts:402,465,481,619,1120`                                 | WarehouseStock          | unowned                                                                  |

## E. Raw SQL and definers (`$queryRaw`, `$executeRaw`; function names are the `ebda_*` definers or the tables named)

| file:line                                                       | function / table                                             | DO-aware file | owner                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------- |
| `app.ts:486`                                                    | ?                                                            | no            | unowned; file touched by #407/#408/#410/#415/#416 (verify the use is covered) |
| `cf/dev-stats.ts:47,48,49,54`                                   | ?                                                            | no            | unowned                                                                       |
| `index.ts:84`                                                   | pg_roles                                                     | no            | unowned                                                                       |
| `lib/coupon-per-customer-limit.ts:19,20`                        | ?                                                            | no            | unowned                                                                       |
| `lib/coupon-per-customer-limit.ts:79,82`                        | orders                                                       | no            | unowned                                                                       |
| `lib/definer.ts:73,441,501,615,718,857 (+4)`                    | ?                                                            | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:964`                                            | ebda_admin_push_player_ids                                   | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:168,170`                                        | ebda_admin_user_ensure                                       | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:681`                                            | ebda_ai_usage_count                                          | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:746`                                            | ebda_audit_log_exists                                        | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:131`                                            | ebda_audit_log_insert                                        | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:767`                                            | ebda_audit_log_retention_count                               | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:776`                                            | ebda_audit_log_retention_page                                | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:795`                                            | ebda_audit_log_retention_purge                               | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:693,695`                                        | ebda_audit_logs_detach_store                                 | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:703,705`                                        | ebda_audit_logs_unlink_user                                  | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:107`                                            | ebda_auth_find_user_id                                       | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:830`                                            | ebda_billing_refund_store_id                                 | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:600`                                            | ebda_entity_store_id                                         | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:1193`                                           | ebda_gold_feed_stores                                        | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:260`                                            | ebda_order_store_id                                          | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:950`                                            | ebda_owned_store_ids                                         | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:1046`                                           | ebda_passkeys_delete                                         | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:282`                                            | ebda_payment_events_store                                    | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:267`                                            | ebda_payment_store_id                                        | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:818`                                            | ebda_plan_store_ids                                          | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:809`                                            | ebda_plan_subscriber_counts                                  | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:979`                                            | ebda_public_store_page                                       | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:994`                                            | ebda_refresh_token_user                                      | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:1054`                                           | ebda_refresh_tokens_purge                                    | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:57`                                             | ebda_resolve_store_id                                        | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:547`                                            | ebda_shipment_store_id_by_tracking                           | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:929`                                            | ebda_store_id_by_domain                                      | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:920`                                            | ebda_store_id_by_slug                                        | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:938`                                            | ebda_store_ids_claiming_domain                               | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:910`                                            | ebda_store_lookup                                            | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:540`                                            | ebda_storefront_for_payment_ref                              | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:576`                                            | ebda_user_addresses_delete                                   | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:563`                                            | ebda_user_revoke_sessions                                    | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:1066`                                           | ebda_user_tokens_delete                                      | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:1001`                                           | ebda_verification_token_user                                 | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:396`                                            | ebda_webhook_inbox_get                                       | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:382`                                            | ebda_webhook_inbox_record                                    | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:416`                                            | ebda_webhook_inbox_update                                    | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:249`                                            | ebda_webhook_order_by_idempotency                            | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:207`                                            | ebda_webhook_resolve_store                                   | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:203`                                            | ebda_webhook_resolve_store,ebda_webhook_resolve_store_scoped | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/definer.ts:1182`                                           | ebda_withdraw_legal_notice_send                              | yes           | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `lib/effective-inventory-sql.ts:77`                             | products                                                     | no            | unowned                                                                       |
| `lib/inngest/functions/accounting-daily-close.ts:48`            | journal_entries,journal_lines                                | yes           | unowned                                                                       |
| `lib/inngest/functions/accounting-period-reconciliation.ts:62`  | accounts,journal_entries,journal_lines                       | yes           | unowned                                                                       |
| `lib/inngest/functions/answer-engine-citation-scan.ts:62`       | ?                                                            | no            | unowned; file touched by #416 (verify the use is covered)                     |
| `lib/inngest/functions/bulk-ai-recommendations.ts:91`           | order_items                                                  | yes           | unowned                                                                       |
| `lib/inngest/functions/order-auto-cancel-unpaid.ts:403`         | orders                                                       | yes           | unowned                                                                       |
| `lib/inngest/functions/order-refunded.ts:333,609,925,990,1283`  | orders                                                       | yes           | unowned; file touched by #414/#416 (verify the use is covered)                |
| `lib/inngest/functions/order-refunded.ts:347`                   | products                                                     | yes           | unowned; file touched by #414/#416 (verify the use is covered)                |
| `lib/inngest/functions/store-usage-snapshot.ts:88,178`          | ?                                                            | yes           | unowned; file touched by #416 (verify the use is covered)                     |
| `lib/order-search-ids.ts:32`                                    | ?                                                            | no            | unowned                                                                       |
| `lib/r2-references.ts:475,498,548,636,711,716`                  | ?                                                            | no            | unowned                                                                       |
| `lib/r2-references.ts:555,559`                                  | pg_class,pg_stat_all_tables                                  | no            | unowned                                                                       |
| `lib/r2-references.ts:540`                                      | pg_roles                                                     | no            | unowned                                                                       |
| `lib/savepoint.ts:6,86,89,93,94`                                | ?                                                            | no            | unowned                                                                       |
| `lib/stock-hold-cap.ts:152,153,212`                             | ?                                                            | no            | unowned                                                                       |
| `lib/stock-hold-cap.ts:217`                                     | orders                                                       | no            | unowned                                                                       |
| `lib/wa/consent.ts:136`                                         | ?                                                            | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `lib/wa/store-events-consumer.ts:41`                            | orders                                                       | no            | unowned                                                                       |
| `routes/admin.routes.ts:2030`                                   | ?                                                            | yes           | unowned; file touched by #408/#410/#414/#416 (verify the use is covered)      |
| `routes/finance.routes.ts:645`                                  | products                                                     | no            | unowned                                                                       |
| `routes/insights.routes.ts:113`                                 | ?                                                            | yes           | unowned                                                                       |
| `routes/merchant-webhooks.routes.ts:187`                        | ?                                                            | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `routes/public.routes.ts:135,2071`                              | ?                                                            | yes           | unowned                                                                       |
| `services/abandoned-cart.service.ts:772`                        | abandoned_carts,orders                                       | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/accounting/backorder-stock-heal.ts:42`                | products                                                     | no            | unowned                                                                       |
| `services/accounting/bank-reconcile.service.ts:712`             | journal_entries,journal_lines                                | no            | unowned                                                                       |
| `services/accounting/bank-reconcile.service.ts:682`             | journal_lines                                                | no            | unowned                                                                       |
| `services/accounting/deadstock-scan.service.ts:251`             | deadstock_flags                                              | yes           | unowned                                                                       |
| `services/accounting/deadstock-scan.service.ts:112`             | order_items,orders                                           | yes           | unowned                                                                       |
| `services/accounting/posting/partial-return-posting.ts:181,573` | journal_entries                                              | yes           | unowned                                                                       |
| `services/accounting/posting/refund-posting.ts:62`              | journal_entries                                              | yes           | unowned                                                                       |
| `services/accounting/purchase-order.service.ts:268`             | products                                                     | yes           | unowned                                                                       |
| `services/accounting/purchase-order.service.ts:242`             | purchase_orders                                              | yes           | unowned                                                                       |
| `services/accounting/reorder-scan.service.ts:149`               | ?                                                            | yes           | unowned                                                                       |
| `services/accounting/reorder-scan.service.ts:164,174`           | order_items,orders                                           | yes           | unowned                                                                       |
| `services/accounting/reorder-scan.service.ts:301`               | purchase_order_items,purchase_orders                         | yes           | unowned                                                                       |
| `services/accounting/reorder-scan.service.ts:264,279`           | reorder_suggestions                                          | yes           | unowned                                                                       |
| `services/accounting/reports.service.ts:118`                    | ?                                                            | yes           | unowned                                                                       |
| `services/accounting/tax-report.service.ts:142`                 | ?                                                            | no            | unowned                                                                       |
| `services/admin-search.service.ts:48`                           | ?                                                            | yes           | unowned                                                                       |
| `services/ai-autofill.service.ts:381`                           | products                                                     | yes           | unowned                                                                       |
| `services/analytics.service.ts:423,518,909`                     | ?                                                            | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/analytics.service.ts:1031`                            | accounts,journal_entries,journal_lines                       | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/analytics.service.ts:1005`                            | backorder_lines,product_variants,products                    | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/analytics.service.ts:361`                             | orders                                                       | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/barcode-scan.service.ts:373,404`                      | order_items                                                  | yes           | unowned                                                                       |
| `services/barcode.service.ts:27,43`                             | ?                                                            | yes           | unowned                                                                       |
| `services/barcode.service.ts:118`                               | product_variants,products                                    | yes           | unowned                                                                       |
| `services/billing/grants.service.ts:265,306`                    | ?                                                            | no            | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `services/billing/grants.service.ts:449,472`                    | billing_grants                                               | no            | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `services/campaign.service.ts:148`                              | newsletter_subscribers                                       | yes           | unowned                                                                       |
| `services/customer-aggregate.service.ts:646`                    | orders                                                       | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/customer-search.service.ts:48`                        | ?                                                            | no            | unowned; file touched by #414 (verify the use is covered)                     |
| `services/fiscal-document.service.ts:262`                       | SET,fiscal_document_counters                                 | yes           | unowned                                                                       |
| `services/gold-rate/gate.ts:93`                                 | gold_rates_current                                           | no            | unowned                                                                       |
| `services/gold-rate/gold-rate.service.ts:215,364,555,745`       | ?                                                            | yes           | unowned                                                                       |
| `services/gold-rate/gold-rate.service.ts:456`                   | SET,gold_rate_settings                                       | yes           | unowned                                                                       |
| `services/gold-rate/gold-rate.service.ts:294,387`               | SET,gold_rates_current                                       | yes           | unowned                                                                       |
| `services/gold-rate/gold-rate.service.ts:454`                   | gold_rate_settings                                           | yes           | unowned                                                                       |
| `services/gold-rate/repricer.ts:86,87,89,90`                    | ?                                                            | no            | unowned                                                                       |
| `services/gold-rate/repricer.ts:206`                            | product_variants                                             | no            | unowned                                                                       |
| `services/gold-rate/repricer.ts:193`                            | products                                                     | no            | unowned                                                                       |
| `services/inventory-decrement.ts:63,72,93,96`                   | product_variants                                             | no            | unowned                                                                       |
| `services/inventory-decrement.ts:41,50`                         | products                                                     | no            | unowned                                                                       |
| `services/inventory.service.ts:52,143,203,231`                  | ?                                                            | yes           | unowned                                                                       |
| `services/inventory.service.ts:165`                             | products                                                     | yes           | unowned                                                                       |
| `services/legal-notice.service.ts:271`                          | legal_notice_sends                                           | no            | unowned; file touched by #415 (verify the use is covered)                     |
| `services/loyalty.service.ts:155`                               | loyalty_points                                               | yes           | unowned                                                                       |
| `services/order.service.ts:1699`                                | carts                                                        | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/order.service.ts:1922`                                | products                                                     | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/payment-providers/instapay.service.ts:93`             | orders                                                       | yes           | unowned                                                                       |
| `services/payment-providers/instapay.service.ts:1061`           | payments                                                     | yes           | unowned                                                                       |
| `services/payment-providers/refund-settle.ts:89`                | payments                                                     | no            | unowned                                                                       |
| `services/payment-state-claims.ts:61`                           | payments                                                     | no            | unowned                                                                       |
| `services/plan-limit.service.ts:230`                            | stores                                                       | yes           | unowned; file touched by #408/#410/#414 (verify the use is covered)           |
| `services/platform/billing-d1.ts:80`                            | ebda_plan_subscriber_counts                                  | no            | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `services/product-index.service.ts:168,317`                     | product_embed_failures                                       | no            | unowned                                                                       |
| `services/product-index.service.ts:410`                         | product_embed_failures,unnest                                | no            | unowned                                                                       |
| `services/product-index.service.ts:156,182,430`                 | product_embeddings                                           | no            | unowned                                                                       |
| `services/product-index.service.ts:105,121,142`                 | product_embeddings,products                                  | no            | unowned                                                                       |
| `services/product-index.service.ts:161`                         | product_embeddings,products,scratch                          | no            | unowned                                                                       |
| `services/product-index.service.ts:286,304`                     | product_embeddings,products,unnest                           | no            | unowned                                                                       |
| `services/product-search.service.ts:125`                        | ?                                                            | yes           | unowned                                                                       |
| `services/product-search.service.ts:191`                        | bundles,promotions                                           | yes           | unowned                                                                       |
| `services/product-search.service.ts:199`                        | categories                                                   | yes           | unowned                                                                       |
| `services/product-search.service.ts:195`                        | categories,promotions                                        | yes           | unowned                                                                       |
| `services/product-search.service.ts:445`                        | product_embeddings,products                                  | yes           | unowned                                                                       |
| `services/product-search.service.ts:219`                        | product_variants,products                                    | yes           | unowned                                                                       |
| `services/product.service.ts:1136,1836`                         | products                                                     | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/qr.service.ts:113`                                    | SET,qr_scan_daily                                            | yes           | unowned; file touched by #416 (verify the use is covered)                     |
| `services/qr.service.ts:120`                                    | qr_scan_daily                                                | yes           | unowned; file touched by #416 (verify the use is covered)                     |
| `services/r2-cleanup.service.ts:133`                            | ?                                                            | no            | unowned                                                                       |
| `services/return.service.ts:217,235`                            | ?                                                            | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/search-log.service.ts:300`                            | ?                                                            | no            | unowned; file touched by #416 (verify the use is covered)                     |
| `services/search-log.service.ts:178,211,296`                    | search_query_daily                                           | no            | unowned; file touched by #416 (verify the use is covered)                     |
| `services/sequence.service.ts:52`                               | SET,sequences                                                | no            | unowned                                                                       |
| `services/setup-guide.service.ts:74,83`                         | stores                                                       | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/shipping-carrier.service.ts:205`                      | Prisma,shipping_carrier_configs                              | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/shipping-carrier.service.ts:311`                      | shipping_carrier_configs                                     | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/sms-consent.service.ts:94`                            | sms_marketing_consents                                       | no            | unowned                                                                       |
| `services/store-closure.service.ts:42`                          | ?                                                            | no            | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `services/store-closure.service.ts:108,154`                     | fiscal_documents                                             | no            | unowned; file touched by #407/#410/#415/#416 (verify the use is covered)      |
| `services/store.service.ts:1036`                                | backorder_lines                                              | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/store.service.ts:1032`                                | backorder_lines,journal_entries                              | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/store.service.ts:1047`                                | expenses,journal_entries,orders                              | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/store.service.ts:1016`                                | expenses,orders                                              | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/store.service.ts:1020`                                | expenses,stock_adjustments                                   | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/store.service.ts:1028`                                | journal_entries,purchase_orders                              | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/store.service.ts:1012`                                | orders,returns                                               | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/store.service.ts:1024`                                | purchase_orders,stock_adjustments                            | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/store.service.ts:1008`                                | returns,reviews                                              | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/store.service.ts:324,326,353,363,1064`                | stores                                                       | yes           | unowned; file touched by #408 (verify the use is covered)                     |
| `services/view-ingest.service.ts:104`                           | SET,product_daily_views                                      | no            | unowned; file touched by #416 (verify the use is covered)                     |
| `services/wallet.service.ts:211,219`                            | customer_wallets                                             | yes           | unowned; file touched by #414 (verify the use is covered)                     |
| `services/warehouse.service.ts:791`                             | OF,product_variants,products                                 | yes           | unowned                                                                       |
| `services/warehouse.service.ts:1013,1020`                       | OF,warehouse_stock,warehouses                                | yes           | unowned                                                                       |
| `services/warehouse.service.ts:723,731`                         | SET,warehouse_stock                                          | yes           | unowned                                                                       |
| `services/warehouse.service.ts:962`                             | product_variants                                             | yes           | unowned                                                                       |
| `services/warehouse.service.ts:797`                             | product_variants,warehouse_stock                             | yes           | unowned                                                                       |
| `services/warehouse.service.ts:970`                             | products                                                     | yes           | unowned                                                                       |
| `services/warehouse.service.ts:813,815`                         | products,warehouse_stock                                     | yes           | unowned                                                                       |
| `services/warehouse.service.ts:980,984`                         | warehouse_stock                                              | yes           | unowned                                                                       |
| `services/webhook-erasure.ts:14,19`                             | webhook_deliveries                                           | no            | unowned                                                                       |

## F. Postgres transaction openers (each opens a connection through Hyperdrive)

`withStore`, `withMoneyTx`, `withRlsBypass`, `withSystemJob`, `acrossStores`, `runInTenantContext`, `runInStoreScope`, `withOwnerTx`, `asPlatformOperator`, `withTenantContext`, `withSavepoint` (a Postgres SAVEPOINT: a no-op or removal is needed once the transaction is not Postgres). Per file counts:

| file                                                        | calls                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `services/billing/subscription-billing.service.ts`          | 27 (withStore 27)                                                        |
| `routes/finance.routes.ts`                                  | 26 (runInTenantContext 26)                                               |
| `routes/admin.routes.ts`                                    | 25 (asPlatformOperator 16, withStore 5, acrossStores 4)                  |
| `services/billing/account.service.ts`                       | 25 (withStore 23, withSavepoint 1, acrossStores 1)                       |
| `lib/inngest/functions/order-refunded.ts`                   | 24 (runInTenantContext 15, withMoneyTx 8, withStore 1)                   |
| `services/email.service.ts`                                 | 19 (withStore 19)                                                        |
| `routes/insights.routes.ts`                                 | 16 (runInTenantContext 16)                                               |
| `routes/payment.routes.ts`                                  | 15 (withStore 12, runInTenantContext 3)                                  |
| `services/store.service.ts`                                 | 15 (withStore 11, acrossStores 1, withMoneyTx 1, asPlatformOperator 1)   |
| `services/legal-notice.service.ts`                          | 15 (asPlatformOperator 15)                                               |
| `services/domain-claim.service.ts`                          | 13 (withStore 13)                                                        |
| `services/payment-providers/instapay-receipt.service.ts`    | 13 (withStore 11, withSavepoint 1, acrossStores 1)                       |
| `services/loyalty.service.ts`                               | 12 (withStore 10, withMoneyTx 2)                                         |
| `mcp/tools/order.tools.ts`                                  | 9 (runInTenantContext 8, withTenantContext 1)                            |
| `lib/jobs/store-db.ts`                                      | 9 (runInStoreScope 3, runInTenantContext 3, withStore 2, acrossStores 1) |
| `services/order.service.ts`                                 | 9 (withStore 3, withMoneyTx 3, withSavepoint 3)                          |
| `routes/stock-adjustments.routes.ts`                        | 8 (runInTenantContext 8)                                                 |
| `routes/smart-layer.routes.ts`                              | 8 (runInTenantContext 8)                                                 |
| `services/cart.service.ts`                                  | 8 (withSavepoint 8)                                                      |
| `services/feature.service.ts`                               | 8 (withStore 7, withMoneyTx 1)                                           |
| `services/payment-providers/instapay.service.ts`            | 8 (withStore 8)                                                          |
| `routes/expenses.routes.ts`                                 | 7 (runInTenantContext 7)                                                 |
| `services/provider-activation.service.ts`                   | 7 (runInTenantContext 5, runInStoreScope 1, asPlatformOperator 1)        |
| `services/accounting/bank-reconcile.service.ts`             | 7 (withStore 6, runInTenantContext 1)                                    |
| `mcp/tools/admin-read.tools.ts`                             | 6 (runInTenantContext 6)                                                 |
| `lib/ci/source.ts`                                          | 6 (runInTenantContext 5, runInStoreScope 1)                              |
| `lib/wa/consent.ts`                                         | 6 (runInTenantContext 6)                                                 |
| `services/lifecycle-emails.service.ts`                      | 6 (withStore 6)                                                          |
| `services/auth.service.ts`                                  | 6 (withStore 3, runInTenantContext 3)                                    |
| `services/pwa.service.ts`                                   | 6 (withStore 6)                                                          |
| `services/plan-limit.service.ts`                            | 6 (withStore 6)                                                          |
| `services/push.service.ts`                                  | 6 (withStore 3, runInTenantContext 3)                                    |
| `services/accounting/analytics-rollup.service.ts`           | 6 (withSavepoint 6)                                                      |
| `services/payment-providers/payment.factory.ts`             | 6 (withStore 4, runInTenantContext 2)                                    |
| `mcp/tools/admin-read-customers-marketing.tools.ts`         | 5 (runInTenantContext 5)                                                 |
| `lib/inngest/functions/order-status-changed.ts`             | 5 (runInTenantContext 4, withStore 1)                                    |
| `routes/sms-consent.routes.ts`                              | 5 (runInTenantContext 5)                                                 |
| `routes/purchase-orders.routes.ts`                          | 5 (runInTenantContext 5)                                                 |
| `routes/merchant-key.routes.ts`                             | 5 (runInTenantContext 5)                                                 |
| `routes/suppliers.routes.ts`                                | 5 (runInTenantContext 5)                                                 |
| `services/page-builder.service.ts`                          | 5 (withStore 3, withSavepoint 2)                                         |
| `services/shipping-carrier.service.ts`                      | 5 (withStore 3, runInTenantContext 1, runInStoreScope 1)                 |
| `services/ai-autofill.service.ts`                           | 5 (withStore 2, withSavepoint 2, runInTenantContext 1)                   |
| `services/provisioning.service.ts`                          | 5 (withMoneyTx 2, withStore 2, acrossStores 1)                           |
| `services/shipment-pickup.service.ts`                       | 5 (runInTenantContext 5)                                                 |
| `services/gold-rate/gold-rate.service.ts`                   | 5 (withMoneyTx 5)                                                        |
| `mcp/agent-auth.ts`                                         | 4 (runInTenantContext 2, withStore 1, runInStoreScope 1)                 |
| `mcp/merchant-auth.ts`                                      | 4 (withStore 4)                                                          |
| `lib/inngest/functions/bulk-ai-aeo.ts`                      | 4 (runInStoreScope 3, withStore 1)                                       |
| `lib/inngest/functions/catalog-import-run.ts`               | 4 (runInStoreScope 4)                                                    |
| `lib/inngest/functions/catalog-import-create-drafts.ts`     | 4 (runInStoreScope 4)                                                    |
| `lib/inngest/functions/order-created.ts`                    | 4 (runInTenantContext 3, withStore 1)                                    |
| `routes/product-model.routes.ts`                            | 4 (runInTenantContext 4)                                                 |
| `routes/campaign-public.routes.ts`                          | 4 (withStore 2, runInTenantContext 2)                                    |
| `routes/webhook.routes.ts`                                  | 4 (withStore 3, runInTenantContext 1)                                    |
| `routes/staff.routes.ts`                                    | 4 (withStore 4)                                                          |
| `services/search-log.service.ts`                            | 4 (withStore 3, withSavepoint 1)                                         |
| `middleware/store-access.ts`                                | 3 (withStore 3)                                                          |
| `middleware/tenant-context.ts`                              | 3 (runInTenantContext 2, runInStoreScope 1)                              |
| `cf/queues.ts`                                              | 3 (runInStoreScope 3)                                                    |
| `lib/definer.ts`                                            | 3 (withSystemJob 3)                                                      |
| `lib/inngest/functions/bulk-ai-geo.ts`                      | 3 (runInStoreScope 3)                                                    |
| `lib/inngest/functions/search-product-index.ts`             | 3 (runInStoreScope 2, acrossStores 1)                                    |
| `lib/inngest/functions/data-retention.ts`                   | 3 (acrossStores 2, withStore 1)                                          |
| `routes/feature.routes.ts`                                  | 3 (withStore 2, asPlatformOperator 1)                                    |
| `services/abandoned-cart.service.ts`                        | 3 (runInStoreScope 2, withStore 1)                                       |
| `services/warehouse.service.ts`                             | 3 (withMoneyTx 3)                                                        |
| `services/onboarding.service.ts`                            | 3 (withStore 2, runInStoreScope 1)                                       |
| `services/notification-dispatcher.service.ts`               | 3 (withStore 3)                                                          |
| `services/cart-recovery-email.service.ts`                   | 3 (runInTenantContext 1, runInStoreScope 1, withStore 1)                 |
| `services/customer-group.service.ts`                        | 3 (withSavepoint 3)                                                      |
| `services/accounting/account.service.ts`                    | 3 (withStore 3)                                                          |
| `services/billing/grants.service.ts`                        | 3 (runInTenantContext 1, acrossStores 1, withStore 1)                    |
| `services/billing/comp-migration.ts`                        | 3 (withStore 3)                                                          |
| `mcp/merchant-write.ts`                                     | 2 (withStore 1, runInTenantContext 1)                                    |
| `lib/repo-factory.ts`                                       | 2 (withStore 2)                                                          |
| `lib/store-members.ts`                                      | 2 (withStore 2)                                                          |
| `lib/inngest/functions/store-usage-snapshot.ts`             | 2 (withStore 2)                                                          |
| `lib/inngest/functions/accounting-period-reconciliation.ts` | 2 (withStore 2)                                                          |
| `lib/inngest/functions/order-auto-cancel-unpaid.ts`         | 2 (runInTenantContext 2)                                                 |
| `lib/inngest/functions/ai-autofill-product.ts`              | 2 (runInStoreScope 2)                                                    |
| `lib/inngest/functions/warehouse-reconcile-sweep.ts`        | 2 (runInStoreScope 2)                                                    |
| `lib/inngest/functions/answer-engine-citation-scan.ts`      | 2 (runInStoreScope 2)                                                    |
| `lib/inngest/functions/r2-orphan-sweep.ts`                  | 2 (withOwnerTx 2)                                                        |
| `lib/wa/store-events-consumer.ts`                           | 2 (runInTenantContext 2)                                                 |
| `lib/wa/link.ts`                                            | 2 (runInTenantContext 2)                                                 |
| `routes/billing.routes.ts`                                  | 2 (withStore 2)                                                          |
| `routes/slug-redirects.routes.ts`                           | 2 (runInTenantContext 2)                                                 |
| `routes/search-insights.routes.ts`                          | 2 (withSavepoint 1, withStore 1)                                         |
| `routes/order.routes.ts`                                    | 2 (runInTenantContext 2)                                                 |
| `routes/staff-invite.routes.ts`                             | 2 (withStore 2)                                                          |
| `routes/backorders.routes.ts`                               | 2 (runInTenantContext 2)                                                 |
| `routes/payment-abandonments.routes.ts`                     | 2 (runInTenantContext 2)                                                 |
| `services/loyalty-automation.service.ts`                    | 2 (runInStoreScope 2)                                                    |
| `services/price-tier.service.ts`                            | 2 (withSavepoint 2)                                                      |
| `services/bulk.service.ts`                                  | 2 (withMoneyTx 2)                                                        |
| `services/onesignal.service.ts`                             | 2 (withStore 2)                                                          |
| `services/barcode-scan.service.ts`                          | 2 (runInTenantContext 2)                                                 |
| `services/campaign.service.ts`                              | 2 (runInTenantContext 1, withStore 1)                                    |
| `services/provider-verification.service.ts`                 | 2 (withStore 2)                                                          |
| `services/qr.service.ts`                                    | 2 (withStore 2)                                                          |
| `services/payment-event.service.ts`                         | 2 (withSavepoint 1, withStore 1)                                         |
| `services/store-mailer.service.ts`                          | 2 (withStore 2)                                                          |
| `services/barcode.service.ts`                               | 2 (withSavepoint 1, withStore 1)                                         |
| `services/catalog-import.service.ts`                        | 2 (runInStoreScope 1, withMoneyTx 1)                                     |
| `services/payment-confirm.service.ts`                       | 2 (withStore 1, runInTenantContext 1)                                    |
| `services/return.service.ts`                                | 2 (withStore 2)                                                          |
| `services/product.service.ts`                               | 2 (withMoneyTx 1, withStore 1)                                           |
| `services/tax.service.ts`                                   | 2 (withStore 2)                                                          |
| `services/accounting/journal.service.ts`                    | 2 (withStore 2)                                                          |
| `services/accounting/expense.service.ts`                    | 2 (runInTenantContext 1, withStore 1)                                    |
| `services/accounting/insights-narration.service.ts`         | 2 (runInStoreScope 1, withStore 1)                                       |
| `services/accounting/purchase-order.service.ts`             | 2 (runInTenantContext 1, withMoneyTx 1)                                  |
| `services/answer-engine/citation-scan.service.ts`           | 2 (withStore 1, withSavepoint 1)                                         |
| `services/inventory/low-stock-scan.service.ts`              | 2 (withStore 2)                                                          |
| `middleware/security.ts`                                    | 1 (withSavepoint 1)                                                      |
| `mcp/resolve-store.ts`                                      | 1 (withStore 1)                                                          |
| `lib/store-customer.ts`                                     | 1 (withStore 1)                                                          |
| `lib/after-tenant-commit.ts`                                | 1 (runInTenantContext 1)                                                 |
| `lib/store-scoped-read.ts`                                  | 1 (runInTenantContext 1)                                                 |
| `lib/store-directory-reconcile.ts`                          | 1 (withStore 1)                                                          |
| `lib/report-range.ts`                                       | 1 (withStore 1)                                                          |
| `lib/order-tax.ts`                                          | 1 (withStore 1)                                                          |
| `lib/cross-store.ts`                                        | 1 (acrossStores 1)                                                       |
| `lib/store-directory-sync.ts`                               | 1 (withStore 1)                                                          |
| `lib/inngest/functions/instapay-receipt-extract.ts`         | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/webhook-delivery.ts`                 | 1 (acrossStores 1)                                                       |
| `lib/inngest/functions/bulk-ai-image-alt.ts`                | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/bulk-ai-tags.ts`                     | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/cart-recovery-email.ts`              | 1 (runInTenantContext 1)                                                 |
| `lib/inngest/functions/payment-webhook-process.ts`          | 1 (runInTenantContext 1)                                                 |
| `lib/inngest/functions/ebda-ads-conversion.ts`              | 1 (withStore 1)                                                          |
| `lib/inngest/functions/bulk-ai-categorize.ts`               | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/bulk-ai-balance-descriptions.ts`     | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/wa-store-events.ts`                  | 1 (runInTenantContext 1)                                                 |
| `lib/inngest/functions/ai-autofill-sweep.ts`                | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/bulk-ai-recommendations.ts`          | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/bulk-ai-product-faqs.ts`             | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/bulk-ai-excerpt.ts`                  | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/accounting-expense-ocr-process.ts`   | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/payment-abandonment-sweep.ts`        | 1 (runInTenantContext 1)                                                 |
| `lib/inngest/functions/bulk-import.ts`                      | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/bulk-ai-seo.ts`                      | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/gold-rate-feed-fetch.ts`             | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/bulk-ai-translate.ts`                | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/order-status-fanout-stuck-sweep.ts`  | 1 (withStore 1)                                                          |
| `lib/inngest/functions/bulk-ai-revert-balance.ts`           | 1 (runInStoreScope 1)                                                    |
| `lib/inngest/functions/review-request.ts`                   | 1 (runInTenantContext 1)                                                 |
| `lib/inngest/functions/accounting-daily-close.ts`           | 1 (withStore 1)                                                          |
| `lib/wa/plan-state.ts`                                      | 1 (withStore 1)                                                          |
| `routes/ai.routes.ts`                                       | 1 (withSavepoint 1)                                                      |
| `routes/store.routes.ts`                                    | 1 (asPlatformOperator 1)                                                 |
| `routes/provider-activation.routes.ts`                      | 1 (asPlatformOperator 1)                                                 |
| `routes/mcp.routes.ts`                                      | 1 (runInStoreScope 1)                                                    |
| `routes/public-store-layout.routes.ts`                      | 1 (withStore 1)                                                          |
| `routes/campaign.routes.ts`                                 | 1 (runInTenantContext 1)                                                 |
| `routes/public.routes.ts`                                   | 1 (withStore 1)                                                          |
| `routes/upload.routes.ts`                                   | 1 (runInTenantContext 1)                                                 |
| `services/inventory.service.ts`                             | 1 (withStore 1)                                                          |
| `services/r2-cleanup.service.ts`                            | 1 (withStore 1)                                                          |
| `services/store-contact.service.ts`                         | 1 (withStore 1)                                                          |
| `services/ai.service.ts`                                    | 1 (withSavepoint 1)                                                      |
| `services/wallet.service.ts`                                | 1 (withMoneyTx 1)                                                        |
| `services/variant.service.ts`                               | 1 (withSavepoint 1)                                                      |
| `services/product-model.service.ts`                         | 1 (withSavepoint 1)                                                      |
| `services/pages.service.ts`                                 | 1 (withSavepoint 1)                                                      |
| `services/affiliate.service.ts`                             | 1 (withMoneyTx 1)                                                        |
| `services/webhook.service.ts`                               | 1 (withSavepoint 1)                                                      |
| `services/wholesale-application.service.ts`                 | 1 (withSavepoint 1)                                                      |
| `services/invoice.service.ts`                               | 1 (withStore 1)                                                          |
| `services/sms-queue.service.ts`                             | 1 (runInStoreScope 1)                                                    |
| `services/affiliate-event.service.ts`                       | 1 (withSavepoint 1)                                                      |
| `services/notification-config.service.ts`                   | 1 (withStore 1)                                                          |
| `services/setup-guide.service.ts`                           | 1 (withStore 1)                                                          |
| `services/plan.service.ts`                                  | 1 (withStore 1)                                                          |
| `services/card-testing-guard.service.ts`                    | 1 (withStore 1)                                                          |
| `services/sequence.service.ts`                              | 1 (withStore 1)                                                          |
| `services/locations.service.ts`                             | 1 (withStore 1)                                                          |
| `services/plan-entitlements.ts`                             | 1 (withStore 1)                                                          |
| `services/product-search.service.ts`                        | 1 (withSavepoint 1)                                                      |
| `services/view-ingest.service.ts`                           | 1 (withStore 1)                                                          |
| `services/sms-consent.service.ts`                           | 1 (withStore 1)                                                          |
| `services/accounting/backorder.service.ts`                  | 1 (withMoneyTx 1)                                                        |
| `services/accounting/deadstock-scan.service.ts`             | 1 (withStore 1)                                                          |
| `services/accounting/assert-store-owns.ts`                  | 1 (runInTenantContext 1)                                                 |
| `services/accounting/reorder-scan.service.ts`               | 1 (withStore 1)                                                          |
| `services/accounting/stock-adjustment.service.ts`           | 1 (withMoneyTx 1)                                                        |
| `services/accounting/profit-anomaly.service.ts`             | 1 (withStore 1)                                                          |
| `services/accounting/posting/order-scope.ts`                | 1 (withStore 1)                                                          |
| `services/platform/access-d1.ts`                            | 1 (withStore 1)                                                          |
| `services/platform/billing-d1.ts`                           | 1 (acrossStores 1)                                                       |
| `services/platform/subscriptions.ts`                        | 1 (withStore 1)                                                          |
| `services/payment-providers/provider-health.ts`             | 1 (runInTenantContext 1)                                                 |
| `services/payment-providers/provider-gate.ts`               | 1 (withStore 1)                                                          |
| `services/payment-providers/refund-settle.ts`               | 1 (runInTenantContext 1)                                                 |
| `services/billing/reminders.service.ts`                     | 1 (withStore 1)                                                          |
| `services/billing/billing-notify.ts`                        | 1 (withStore 1)                                                          |
| `services/billing/go-live-gate.ts`                          | 1 (withStore 1)                                                          |

**N-17 lite (Ruling NZ-D23) DONE in draft PR `feat/nz-remove-hyperdrive`: the references below are removed except comments in the legacy local-dev scripts (`ebda-dev-api.sh`, `ebda-parity-as-app.sh`, `stage1-exit-*`, `playwright.editor-live.config.ts`, `spikes/`), which die with N-16.** Hyperdrive binding references (N-17, before): `apps/api/src/worker.ts:184` (`env.HYPERDRIVE.connectionString`), `apps/api/src/cf/bindings.ts:158` (type), `apps/api/src/config/index.ts:55` (comment), plus `apps/api/wrangler.jsonc`, `scripts/ebda-cf-api-config.mjs`, `cf-api-deploy.yml`.

## G. Residuals of THIS PR (N-10d) that the final PRs must close

Each is `file:line` measured at the time of writing; owner = the PR named.

| #   | Residual                                                                                                                                                                                                                                                                                                    | Where                                                                                                                    | Owner                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| G1  | CLOSED: `--family audit --commit` re-imports every DO store's Postgres audit rows into its StoreDO (`__auditimport`, idempotent by id) and verifies per store before the flip. Prod measure 2026-11-04: 48 rows, one store.                                                                                 | `scripts/cf/cutover-platform-family.mjs` `reimportDoStoreAudit`                                                          | this PR                                       |
| G2  | The audit viewer on D1 shows the actor id only (no email / name join: identity lives in `ebda-accounts`).                                                                                                                                                                                                   | `lib/definer.ts` `listAuditD1`                                                                                           | N-8 (identity)                                |
| G3  | Store-scoped audit rows are NOT in the cross-store viewer after the `audit` marker (they live in each DO); the viewer takes `?storeId=` and reads that store's DO; impersonated actions are mirrored to D1.                                                                                                 | `lib/definer.ts` `platformAuditLogs.list`, `services/audit-sink.ts`                                                      | Ruling NZ-10D-2                               |
| G4  | The Postgres audit leg (stores still on Postgres, and the `pg` fallback when the home cannot be decided) still calls `ebda_audit_log_insert` and the retention/detach/unlink/exists definers.                                                                                                               | `lib/definer.ts` (`insertAuditLogPg`, `auditRetention`, `detachStoreAuditLogs`, `unlinkUserAuditLogs`, `auditLogExists`) | N-16 deletes them once every store is on a DO |
| G5  | `withSavepoint` wraps `manualPaymentClaim.create` in `submitSubscriptionReceiptInner` and the receipt submit: a Postgres SAVEPOINT on the ambient transaction. With claims on D1 the savepoint still runs on the (Postgres) request transaction; when that transaction is gone it must become a plain call. | `services/billing/account.service.ts`, `services/payment-providers/instapay-receipt.service.ts`                          | N-16                                          |
| G6  | CLOSED: cron `payments-reconcile` (`*/15`, `services/billing/payments-reconcile.service.ts`) links, rolls back or confirms half-done receipts / claims after 15 min and pages P1 for anything it cannot decide.                                                                                             | `cf/cron.ts`                                                                                                             | this PR                                       |
| G7  | CLOSED (N-27): `paymentsSurface` + `paymentsErasurePort` anonymise payer PII in `instapay_receipts` / `manual_payment_claims` after the store-do gate (not yet assembled into a production erasure job: nothing in `apps/api/src` builds the surface list today, so the job wiring is N-25's follow-up).    | `cf/erasure/surfaces.ts`, `services/billing/payments-erasure.ts`                                                         | this PR + job wiring unowned                  |
| G8  | R2 orphan checks read Postgres for platform tables; D1 is now asked too (`lib/r2-platform-d1-references.ts`) for `system_settings` and `manual_payment_claims`. `stores` (logo/favicon) and `users.avatar` are still read in Postgres only.                                                                 | `lib/r2-references.ts` `PLATFORM_R2_TABLES`                                                                              | N-16 / N-8                                    |
| G9  | The weekly `audit-log-archive` job still counts, exports and purges Postgres (`auditRetention`); the Cloudflare half (D1 + every DO store) runs first. Delete the Postgres half with N-16.                                                                                                                  | `lib/inngest/functions/audit-log-archive.ts`                                                                             | N-16                                          |
| G10 | `payments` may only be on D1 when `billing` is (the router refuses with 503 `PLATFORM_FAMILY_ORDER`, the script refuses `--commit`). Run order: billing, then payments.                                                                                                                                     | `services/platform/router.ts`                                                                                            | runbook                                       |

## Group C update (fix/nz-routes-c)

Sweep subset `^((GET|POST|PUT|PATCH|DELETE) /(admin|webhooks|alerts)|SCHEDULED)`: before 110 requests / 95 failing -> after 110 / 4 failing: `GET`/`DELETE /admin/notifications/onesignal/devices*` (Postgres table `onesignal_subscriptions`), `GET /admin/stores/:storeId/push/broadcasts` (503 PUSH_NOT_CONFIGURED: OneSignal env not set in the harness) and `POST /alerts/webhooks/sentry` (503: `ALERTS_WEBHOOK_TOKEN` not set in the harness). Cron ticks `store-directory-reconcile`, `shipping-tracking`, `backup-sweep` and the Bosta sweep webhook answer without Postgres. See N-10e in the plan.
