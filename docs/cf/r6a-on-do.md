# The last three Postgres-only flows on the StoreDO (INFRA-CF-1 PR R6a, Rulings CF-R6A-1 .. CF-R6A-4)

`docs/cf/not-on-do.json` now lists nothing: `node scripts/cf/not-on-do.mjs` exits 0 (`{"open":true,"refusals":0,"postgresOnly":0}`).

| Flow                                                                          | Where it lives on the DO                                                                                                                           | Replaces                                                                 | Evidence                                                                                                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin command-palette search, every product lexical search, customer matching | money ops `searchProducts`, `searchCustomers` (`do/search.ts`, `do/search-customers.ts`); the palette route reads display rows through `storeRepo` | `ebda_product_search_ids`, `ebda_customer_search_ids` (SECURITY DEFINER) | `tests/integration/repo-factory-admin-search-contract.test.ts`, `apps/api/workers-do/palette-search.test.ts`                                            |
| E-mail campaigns, recipients, unsubscribe, send cap, `campaign-send` job      | DO-writable `Campaign` / `CampaignRecipient`; `inCampaignStore` (campaign.service)                                                                 | request-scoped Prisma on `campaigns` / `campaign_recipients`             | `tests/integration/repo-factory-campaign-contract.test.ts`, `apps/api/workers-do/campaigns.test.ts`                                                     |
| Shopper account erasure                                                       | money op `eraseShopper` (`do/erase-shopper.ts`), called by `AuthService.eraseAccount` before its Postgres transaction                              | the store-owned half of the Postgres transaction                         | `tests/integration/repo-factory-erase-shopper-contract.test.ts`, `tests/unit/erase-shopper-parity.test.ts`, `apps/api/workers-do/erase-shopper.test.ts` |
| InstaPay order receipts at cutover                                            | `PG_SOURCED_DO_TABLES` (cf-migrate coverage), migrate and verify scripts                                                                           | n/a (new at cutover)                                                     | `packages/cf-migrate/test/pg-sourced.test.ts`, `scripts/cf/rehearse-cutover.sh`                                                                         |

## Shopper erasure: anonymise or delete, table by table

Legal-record rules are the Postgres function's, not the registry's. The registry (`cf/erasure/registry.generated.ts`) stays the PDPL job's driver and the parity test's checklist: every customer-pii table has a verdict in `tests/unit/erase-shopper-parity.test.ts` (handled, kept like Postgres with the reason, or not a shopper's data).

- Anonymised, never deleted: orders (identity fields only), reviews (author link), the wallet ledger (notes, balance written off), the merchant CRM row (single-row match only), campaign recipients SENT inside the send-cap window (so erasure cannot reset the store's cap).
- Deleted: addresses, carts, abandoned carts, wishlists, push subscriptions, loyalty points and transactions, B2B applications, newsletter subscription, SMS consent, WhatsApp consent (except an unlinked STOP opt-out), every other campaign recipient row of the address.
- R2: receipt screenshots of the shopper's orders are deleted after the commits (ids returned by the op); the avatar as before.
- Admin accounts: refused 403 (the role gate runs in the service and again in the op).

## Residuals

- A rollback does not replay receipts filed on the DO after the flip.
- The DO order search and palette treat `customers.id` as the id `orders.customer_id` carries (Ruling CF-R6A-1, found, not changed).
- `returns`, `shipments`, `audit_logs`, `customer_rfm_snapshots`, and the wallet row (balance 0) are left like Postgres leaves them; the PDPL job scrubs them.
