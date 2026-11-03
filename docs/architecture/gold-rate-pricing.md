# Gold-rate pricing (Phase B5)

A merchant can price a piece from today's gold rate instead of typing a price. This page is the map: the model, the one formula, who writes what, the cache layers a rate change must clear, the failure codes, and the runbook for "my checkout is blocked". Decisions and their reasons are in `docs/RULINGS.md` (B5-12 to B5-24); this page says where the code is.

## The model, in one paragraph

`products.price` and `product_variants.price` stay THE price every reader uses (cart, order, feed, search, B2B tiers, JSON-LD). For a gold row only the **repricer** writes it, and a database trigger refuses any other write (`gold_price_guard_*`, migration `20261102000200_gold_rate_pricing`). The merchant stores a **spec** (karat, weight in milligrams, making charge, margin in basis points) and a **rate per karat** (piastres per gram); the repricer turns those into a price whenever a rate, a spec, a mode or the rounding step changes. Everything is an integer. Nothing floats, nothing is parsed from `facts`.

## The formula (Ruling B5-14)

`final = roundHalfUp(((weightMg x ratePerGram + makingValue) x (10000 + marginBps)) / (10^7 x step)) x step`, one rounding, computed in BigInt. Making value is `makingChargeValue` (fixed) or `makingChargeValue x weightMg / 1000` (per gram). The metal / making split shown to shoppers is display-only, each half rounded independently, never summed into the price. Source: `packages/shared/src/commerce/gold-price.ts` (`computeGoldUnitPrice`); the admin card previews with the same function, so what the merchant sees is what the repricer writes.

## Who writes what

| Thing                     | Writer                          | Where                                                      |
| ------------------------- | ------------------------------- | ---------------------------------------------------------- |
| Rate (manual)             | store owner (`store:settings`)  | `PUT /stores/:id/gold-rates`, `GoldRateService.applyRates` |
| Rate (automatic)          | the `gold-rate-feed-fetch` cron | free sources behind `feed/adapter.ts` (Ruling B5-15)       |
| Pending feed rate         | owner confirms / rejects        | `POST /:rateId/decision`                                   |
| Settings                  | owner                           | `PUT /settings`                                            |
| A product's spec and mode | `products:write`                | `PUT /products/:id/pricing`, `setProductPricing`           |
| Many products' mode       | owner                           | `POST /bulk/pricing-mode`, `bulkSwitchMode` (500 per call) |
| `price` of a gold row     | the repricer ONLY               | `services/gold-rate/repricer.ts`, inside `withRepriceFlag` |

Every write takes a per-store advisory lock, then `FOR UPDATE` on `gold_rates_current`, writes an append-only history row (`gold_rates`) and audit rows, runs the repricer in the same transaction and, after the commit, purges the caches. Checkout reads the same rows `FOR SHARE`, so it waits for a rate write in flight and sees a committed one.

## Payment for gold (Ruling SHARIA-GOLD-1)

An order with a gold line is paid in full online by default: `assertGoldPaymentAllowed` refuses COD and installments (valU, Kiosk, Kashier `bnpl`) with 409 `GOLD_PREPAID_ONLY` in `OrderService.create`, `createAdminOrder` and `POST /payments/create`; the checkout hides them (`/payments/config` `goldPrepaidOnly`); a gateway page for a gold order leaves the installment methods out. The merchant switch is `store.settings.goldAllowDeferredPayment` (default off, server-owned key), written by `PUT /stores/:id/gold-rates/payment-policy` with `confirm: true`. The store Durable Object checkout (`packages/repo/src/do/checkout.ts`) runs the same shared rule against `store_config.settings`. Tests: `tests/unit/gold-payment-policy.test.ts`, `packages/repo/test/do-gold-payment-policy.test.ts`.

## Order paths (Ruling B5-17, B5-18)

Every path that can create an order calls `assertGoldLinesPriceable` (rate present and inside the store's max age, else 409 `GOLD_RATE_STALE`; materialised price equals the recomputed one, else 409 `GOLD_PRICE_DRIFT` plus a P1 alert), writes `order_items.gold_snapshot` (karat, weight, rate, rate id, making, margin, step, unit price) and re-checks the rate ids inside the money transaction with `assertSameRates` (a rate that moved is `PRICE_CHANGED`). The paths: public checkout, signed-in checkout, admin phone order, payment links, the MCP `place_order`, cart quote. A static test (`tests/unit/gold-gate-every-order-path.test.ts`) fails if a new `order.create` appears without the gate. Refunds and returns use the snapshot, never today's rate; an exchange that includes a gold line is refused (`GOLD_EXCHANGE_UNSUPPORTED`, B5-19).

A **cart line carries a quote** (`quoted_unit_price`): when the current price differs, the cart and checkout show "السعر اتحدّث" (`PriceChangedNotice`) and the shopper continues with `POST /public/cart/acknowledge-prices` (empty strict body; the new quote is the server's price, never a client value). Nothing is charged before they continue.

## What the shopper may know (Ruling B5-13)

`publicGoldPricingSchema` (strict): karat, weight, today's rate, when it was recorded, the store's max age, and (only when the merchant turned it on) the metal / making split. Never the margin, the making settings, the rate row id or where a rate came from. Customer order reads pass through `redactOrderForCustomer` (B5-23): the line snapshot is cut to what was shown, `costPrice` is removed. The storefront shows the line (`GoldRateLine`), the stale state by the browser clock (display only; checkout refuses regardless) and the moved-price notice.

## Cache layers a rate change clears (NEVER-stale, Ruling B5-21)

Price is NEVER-stale. After every write path (manual, feed, confirming a pending rate, settings change, spec or mode change, bulk switch, CSV import of a spec) `invalidateStoreProductCaches` (the IMMEDIATE variant, never the order-coalesced one) clears: Redis `public:products:`, `public:product:`, `public:suggest:`, `admin:products:`, bundle and category keys; the in-process fallback; and ONE storefront revalidation for the `products:`, `categories:` and `bundles:` tags (the Next data cache, the product feed fetch and the `llms.txt` product fetch are tagged `products:<store>`). The one documented residual is a third party that holds the feed or `llms.txt` past our purge (a CDN, a shopping feed): for a store that sells gold the edge window is at most 60 seconds with no stale-while-revalidate tail (feed: `X-Gold-Pricing` header; `llms.txt`: `pricingMode` on the product list). Checkout re-prices from the database, so nobody is charged the old figure.

## Rate sources and the crons (Ruling B5-15)

Free, keyless, commercial-use sources behind a neutral adapter: gold-api.com XAU/USD x open.er-api USD/EGP, fawazahmed0 as fallback, every 6 hours (`5 */6 * * *`). Two sources more than 2 percent apart store the rate `pending`. A jump over the store's gate (default 5 percent) is `pending` for a feed rate and a 409 `GOLD_RATE_CONFIRM_REQUIRED` for a manual one (confirm with `confirm: true`). The staleness watch (`7 * * * *`) warns the owner 4 hours before the limit and again when it passes. Both crons read a SECURITY DEFINER function first so an empty tick costs one Inngest execution (`EMPTY_PATH_STEPS`, INNGEST-BUDGET-1). The provider is named in exactly one file, the admin `RateAttribution` (licence attribution); `tests/unit/gold-provider-name-gate.test.ts` fails anywhere else.

## Failure codes

| Code                                                                 | Where           | Meaning                                                                                     |
| -------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `GOLD_RATE_STALE`                                                    | checkout, quote | no rate, or older than the store's max age (default and ceiling 26 h). Fails closed.        |
| `GOLD_PRICE_DRIFT`                                                   | checkout        | materialised price differs from the recomputed one: a repricer bug, P1 alert, order refused |
| `PRICE_CHANGED`                                                      | checkout        | the shopper's quote or total moved; `details.lines` for a gold line                         |
| `GOLD_RATE_CONFIRM_REQUIRED`                                         | rate write      | manual rate over the jump gate, or a karat that disagrees with 24 k                         |
| `GOLD_PRICE_MANAGED`                                                 | any price write | someone wrote a gold row's price outside the repricer                                       |
| `GOLD_RATE_MISSING`                                                  | switch to gold  | no fresh rate for the product's karat                                                       |
| `GOLD_CATALOGUE_TOO_LARGE`                                           | repricer        | more than 5000 gold rows in one store (cap)                                                 |
| `GOLD_IN_BUNDLE`, `GOLD_NO_PRICE_TIERS`, `GOLD_EXCHANGE_UNSUPPORTED` | spec / return   | the exclusions of Ruling B5-19                                                              |

## Runbook: "my checkout is blocked"

1. Admin, Catalog, Gold rates. A yellow banner says which of the two it is: a rate older than the limit, or a pending automatic rate. The dashboard shows the same banner.
2. Stale: type today's rates and save (the 21 k and 18 k can be filled from 24 k). Every gold product reprices at once; the storefront is purged in the same request.
3. Pending: confirm or reject the automatic rate in the banner.
4. A real market move trips the jump gate: the editor shows the confirm dialog with the size of the jump; applying it sends `confirm: true`. An automatic rate over the gate waits in the pending banner and never applies itself.
5. Need gold pricing OFF now (bad source, dispute): `scripts/gold-rate/freeze-all.mjs --store <slug>` (dry run first; `--apply` freezes each gold product at its current price through the service; `--yes-production` is Ahmad's to pass).
6. `GOLD_PRICE_DRIFT` in the logs or a P1 alert: do not retry orders. The repricer and the gate disagree; freeze the store, then read the alert context (store id, line count) and the last `gold_rates` rows.

## Tests and defences

Unit: `gold-price`, `gold-pricing-schema`, `gold-rate-feed*`, `gold-rate-staleness-watch`, `gold-gate-every-order-path`, `gold-rate-cache-layers`, `gold-order-redaction`, `gold-admin-*`, `gold-storefront-display`, `gold-freeze-all-script`. Integration (real Postgres): `gold-rate-rls`, `gold-price-guard-trigger`, `gold-rate-apply`, `gold-cron-definers`, `gold-checkout`. Every money guard has a mutation entry in `docs/security/defence-mutations.json` (ids `money-gold-*`); the record is `docs/security/defence-mutation-record.md`.
