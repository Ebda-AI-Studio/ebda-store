# Ebda pricing — locked 2026-10-05

Owner: Ahmad. Session: plan prices with the coding agent. Amelia Aurum catalogue and `founding_free` stay last.

Engine on `main` still has placeholders. This file is the source of truth until those numbers are filled in.

## Locked

| Decision                    | Value                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public free plan            | **No**                                                                                                                                                                      |
| Per-order / PAYG commission | **No**                                                                                                                                                                      |
| Platform fee (bps)          | **0** — merchant pays gateway rates only. COD never has a cut.                                                                                                              |
| Trial                       | **14 days on Growth**                                                                                                                                                       |
| Names                       | **Basic / Growth / Business**                                                                                                                                               |
| Monthly list (EGP, flat)    | **1,490 / 3,490 / 9,990**                                                                                                                                                   |
| Annual                      | **25% off** = 9 months prepaid: **13,410 / 31,410 / 89,910**                                                                                                                |
| Custom domain               | Every paid plan (`<slug>.ebda.app` still included)                                                                                                                          |
| Order cap                   | Soft (warn + grace) **then hard after 7 days**                                                                                                                              |
| Ebda SaaS VAT               | **Flat invoices until Ahmad registers.** When VAT is paid, add 14% in the engine — do not bake it into 1,490. Merchant-store 14% VAT (`taxEnabled`) is a separate question. |
| Amelia                      | Hidden `founding_free` (unlimited, 0 fee, admin-granted) — **not provisioned in this commit**                                                                               |

## Entitlements (committed defaults)

| Lever                                                  | Basic     | Growth    | Business           |
| ------------------------------------------------------ | --------- | --------- | ------------------ | -------------------------------------------------------------------- |
| Price / month (piastres)                               | 149_000   | 349_000   | 999_000            |
| Price / year (piastres)                                | 1_341_000 | 3_141_000 | 8_991_000          |
| Staff seats                                            | 2         | 5         | 15                 |
| Orders / month                                         | 300       | 3_000     | unlimited (`null`) |
| Products                                               | unlimited | unlimited | unlimited          |
| Stores                                                 | 1         | 1         | 3                  |
| Custom domain                                          | yes       | yes       | yes                |
| “Powered by Ebda”                                      | yes       | off       | off                |
| COD + InstaPay + gateways                              | all       | all       | all                |
| Carriers                                               | all       | all       | all                |
| WhatsApp                                               | `wa.me`   | `wa.me`   | `wa.me`            |
| Abandoned cart                                         | no        | yes       | yes                |
| API / webhooks                                         | no        | no        | yes                |
| Merchant MCP (AI assistant, keys + read + write tools) | no        | yes       | yes                | <!-- 2026-10-14 Ahmad: opened to Growth; Ruling R-EBDA-PRICING-5 --> |
| Analytics                                              | basic     | standard  | advanced           |
| Support                                                | email     | chat      | priority           |

Order-cap enforcement is the only hard stop, and only after the 7-day grace.

## Implementation status

Implemented on branch `feat/locked-pricing` (see `docs/plans/done/2026-10-05-pricing-implementation.md` and rulings R-EBDA-PRICING-1 to 10 in `docs/RULINGS.md`). Plan codes in the DB: `basic`, `growth`, `business`; `founding_free` exists hidden and unassigned.

Update 2026-10-26: Amelia is a regular client on Growth (EBDA-FUNNEL-15), not `founding_free`; the move off `comped` is `scripts/ebda-amelia-comp-migration.mjs` (EBDA-FUNNEL-19, dry-run by default, not yet run). Extra stores: the oldest store is the billing parent and children are included, never charged (EBDA-FUNNEL-18).
