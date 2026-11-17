# Locked pricing implementation plan

**Goal:** Basic/Growth/Business prices and the Growth trial match Ahmad's locked decision.
**Architecture:** Add a forward catalog migration; keep historical migrations and legacy subscription codes intact. Publish the same monthly and annual prices on the bilingual marketing and help pages. Gate new orders after seven days over the monthly cap.
**Spec:** docs/plans/done/2026-10-05-pricing-decisions.md

- [x] Add priced paid catalog rows; hide historical Free/Pro from public selection, zero their fees, preserve existing subscription references.
- [x] Resolve locked catalog fallback values and create a fourteen-day Growth trial atomically during self-serve provisioning.
- [x] Gate both shopper and admin order creation after seven days over the current month's cap; expired trials cannot place orders.
- [x] Publish monthly/annual prices and bilingual billing copy.
- [x] Entitlements the first pass left ungated: stores 1/1/3, "Powered by Ebda" removal (Growth + Business), API access (Business; merchant MCP opened to Growth + Business 2026-10-14, Ruling R-EBDA-PRICING-5), analytics tiers; support tier is a label.
- [x] Reconcile the seeded SP5 catalog: one forward migration (`20261007000000_locked_pricing`) leaves the DB equal to `DEFAULT_PLAN_SEEDS`; hidden `free`/`pro`/`comped` kept, `founding_free` added hidden.
- [x] Run focused catalog, onboarding, order-limit, gate and billing checks; sweep references (see PR body).

Rulings: `docs/RULINGS.md`, R-EBDA-PRICING-1 to 10.

## Where each lever is enforced

| Lever                                   | Server path                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Staff 2/5/15                            | `POST /stores/:storeId/staff` -> `assertWithinLimit(maxStaff)`                                                              |
| Orders 300/3,000/unlimited, 7-day grace | `assertOrderAllowed` in `OrderService.create`, `OrderService.createAdminOrder`, payment-links route                         |
| Stores 1/1/3                            | `assertOwnerMayCreateStore` in `StoreService.create` and `OnboardingService.createStore`                                    |
| Branding                                | `remove_branding` feature (plan layer in `FeatureService.rowsToMap`): storefront footer, customer/newsletter/campaign email |
| Merchant MCP (Growth + Business)        | `merchant_mcp` feature (same layer, `planIncludesMerchantMcp`): key routes + MCP runtime                                    |
| Abandoned cart                          | `abandoned_cart` feature (same layer)                                                                                       |
| Analytics tiers                         | `requireAnalyticsTier` on `insights.routes.ts`                                                                              |
| Custom domain                           | all plans; existing `assertWithinLimit(customDomain)` unchanged                                                             |

## Evidence and remaining work

Unit and integration counts are in the PR body. Not exercised: live billing provider, browser UAT, production deploy. Closed 2026-10-26 (PLANS-ALL-1): the 402 upsell (API `upgradeTo` on every plan 402, the admin dialog, and a 403 `FEATURE_DISABLED` upgrade target; only Basic / Growth / Business are named, EBDA-FUNNEL-14), parent/child billing for extra stores (EBDA-FUNNEL-18) and the Amelia move off `comped` (EBDA-FUNNEL-19, script written and reviewed, NOT yet run on production: the controller decides). No deployment was performed.
