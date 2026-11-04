# NEON-ZERO routes, group B (per-store admin, not money/stock)

Sweep: `apps/api/workers-test/route-sweep.test.ts`, Postgres dead, all markers set, store on D1 + DO. Filter with
`SWEEP_FILTER="<regex>"` (matched against `METHOD /path`) with `SWEEP_STRICT=1`.

Group B subset (341 requests): before 109 failing (5xx or no answer), after 12 failing (merged with integ at e4d9fbcdb), 109 2xx, 220 expected 4xx.

Left, with the reason (none is a Postgres read of per-store data that can move to storeDb):

| Route                                                                    | Why                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /onboarding/state`                                                  | the account (identity) and the owner's store (D1) are read without Postgres now; what still fails is `getSubscriptionBillingState` (billing track: `withStore` on `storeSubscription` / `manualPaymentClaim`, D1 platform models) |
| `GET /uploads/list`                                                      | 503 `STORAGE_NOT_CONFIGURED`: storage is an S3-compatible client (endpoint + keys), not a Worker binding, so there is nothing to bind in the test Worker; a real endpoint would be a network dependency                           |
| `GET /stores/public/:storeId/shipping(/area-rates)`, bosta sweep webhook | group A (shipping)                                                                                                                                                                                                                |
| `POST /alerts/webhooks/sentry`, `POST /auth/login`                       | config (no token) and the customer-auth PR                                                                                                                                                                                        |

Done in the follow-up: customer-to-group assignment (wholesale approve / revoke) on a DO store through the named store ops
`customerSetGroup` / `customerCreateInGroup`, atomic with an audit row (`workers-test/wholesale-do.test.ts`, Postgres dead); onboarding
store create / go-live / verified-email gate via identity + D1; WA events queue bound in the test Worker.

Not converted: `PaymentConfig` writes in
`setPaymentMethods`, product-model upload and `/usdz` (`runInTenantContext`), MCP denial audit-log writes.

`tests/unit/route-table-manifest.test.ts` fails on integ already (the generator indents with 1 space, the committed file is
prettier-formatted); it is not touched here.
