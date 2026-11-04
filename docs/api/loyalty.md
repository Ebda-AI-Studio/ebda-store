# Loyalty API (admin and storefront)

All admin routes: `/api/v1/stores/:storeId/loyalty/...`, store admin or platform admin, plan feature `loyalty`.
Storefront routes: `/api/v1/public/:storeId/loyalty/...`.

| Route                                                                                | Notes                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `GET /loyalty/settings`, `PUT /loyalty/settings`                                     | store switch and rules                                                                       |
| `GET /loyalty/stats`                                                                 | members per tier, points issued / redeemed / outstanding                                     |
| `GET /loyalty/members`                                                               | page of members with the customer's name and email; `tier` filter                            |
| `GET /loyalty/members/:customerId`                                                   | one customer's balance and tier progress                                                     |
| `GET /loyalty/members/:customerId/transactions`                                      | that customer's ledger, newest first                                                         |
| `GET /loyalty/transactions`                                                          | the store-wide ledger (`type`, `customerId`, date range)                                     |
| `POST /loyalty/members/:customerId/award`                                            | manual award (below)                                                                         |
| `GET /public/:storeId/loyalty/info`                                                  | public program summary                                                                       |
| `GET /public/:storeId/loyalty/my-points`, `GET .../my-transactions`, `POST .../join` | the signed-in customer; `my-transactions` and `join` need the `loyalty` feature on the store |

## Manual award

`POST /loyalty/members/:customerId/award`

```json
{ "points": 50, "type": "earn_manual", "description": "goodwill" }
```

- `points`: a whole number, not zero, between -100000 and 100000. A negative value takes points off (it counts as redeemed).
- `type`: `earn_manual`, `earn_referral`, `earn_review`, `earn_birthday` or `adjust`. `description` is at most 500 characters.
- `customerId` must be a customer account of THIS store, otherwise `404 CUSTOMER_NOT_FOUND`.
- Answer: `{ "success": true, "data": { "newBalance": 150 } }`.

## Where the data lives

A store on its Durable Object keeps the whole loyalty ledger there (earn, redeem, reversals, manual / signup / review awards and every read
above). A store on Postgres keeps it in `loyalty_points` and `loyalty_transactions`. The response shapes are identical on both; the contract
test `tests/integration/repo-factory-money-contract.test.ts` runs every operation against both backends.
