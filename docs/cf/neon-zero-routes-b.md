# NEON-ZERO routes, group B (per-store admin, not money/stock)

Sweep: `apps/api/workers-test/route-sweep.test.ts`, Postgres dead, all markers set, store on D1 + DO. Filter with
`SWEEP_ONLY="<regex>,<regex>"` (matched against `METHOD /path`; bound through `vitest.workers.config.mts`), and
`SWEEP_STRICT=1` now really asserts (both are Worker bindings; `process.env` is empty inside workerd).

Group B subset (341 requests): before 109 failing (5xx or no answer), after 12 failing (merged with integ at e4d9fbcdb), 109 2xx, 220 expected 4xx.

Left, with the reason (none is a Postgres read of per-store data that can move to storeDb):

| Route                                                                                         | Why                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /onboarding/state`, `POST /onboarding/store`, `POST /onboarding/stores/:storeId/go-live` | read the merchant `User` and the owner's store through `withUser`; the account lives in the identity service, so the port is an identity change (getAccountsBrief), not a store-DO read |
| `DELETE /stores/:storeId/whatsapp-link/`                                                      | `sendStoreEvents` throws by design when the `WA_EVENTS_QUEUE` binding is absent; the test Worker has none                                                                               |
| `GET /uploads/list`                                                                           | 503 `STORAGE_NOT_CONFIGURED`: no R2 binding in the test Worker                                                                                                                          |
| `GET /stores/public/:storeId/shipping(/area-rates)`, bosta sweep webhook                      | group A (shipping)                                                                                                                                                                      |
| `POST /alerts/webhooks/sentry`, `POST /auth/login`                                            | config (no token) and the customer-auth PR                                                                                                                                              |

Not converted (need a shared-helper decision): customer-to-group assignment on a DO store answers 501
`CUSTOMER_GROUP_ASSIGN_UNSUPPORTED` (`Customer` is not DO-writable, so wholesale approve fails there), `PaymentConfig` writes in
`setPaymentMethods`, product-model upload and `/usdz` (`runInTenantContext`), MCP denial audit-log writes.

`tests/unit/route-table-manifest.test.ts` fails on integ already (the generator indents with 1 space, the committed file is
prettier-formatted); it is not touched here.
