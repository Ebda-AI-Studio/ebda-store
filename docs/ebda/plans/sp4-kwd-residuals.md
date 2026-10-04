# SP4 task 2 — KWD / fils / Kuwait residuals

Scope: every remaining `KWD`, lowercase `fils`, `Kuwait`/`الكويت`, `KNET`, `+965`, `Asia/Kuwait`, `KW`
occurrence in `apps/*/src` and `packages/*` source (tests excluded), after the EGP conversion.
Generated from `grep` on branch `claude/sp4-egypt`; each group is justified. Anything not listed here
was converted (see "What changed" at the bottom).

## 0. The rules this branch implements

- Money is an integer in **minor units**. EGP: 1 EGP = 100 piastres, 2 decimals, symbol `ج.م` / `EGP`.
- The scale comes from **one** function: `currencyExponent(code)` in `packages/shared/src/region`
  (EGP 2, USD 2, KWD 3, JPY 0). Nothing else hard-codes `100` / `1000`: `toMinor`, `tryToMinor`,
  `roundToMinor`, `fromMinor`, `minorToDecimalString`, `formatMoney`, `excelMoneyFormat`,
  `convertMinor`, `minorUnitsPerMajor` all derive from it.
- **Rounding rule: half up to the piastre, integer arithmetic.** This is exactly what FWB already did
  (`Math.round` on non-negative values, for VAT, percentage discounts and FX), so behaviour is unchanged
  apart from the scale. `mulDivRound` does it without float multiplication (`base * 0.14` can land on
  `x.4999…` for a true half-piastre). Refund/discount/tax apportionment keeps FWB's _cumulative floor_
  allocation (`allocatePartialReturn`), which is what makes a sequence of partial refunds sum to exactly
  the paid total.
- **VAT is charged after discount** (`vatOnDiscounted(subtotal, discount, bps)`); `computeOrderTax`
  (API charge + storefront display) is a thin wrapper over it. Default 14 % (`REGION.defaultVatBps`),
  per-store configurable via `TaxRate` rows. New stores get an **active 14 % "VAT" rate row** but
  `Store.taxEnabled` stays `false` (ruling TAX-1: the charge is gated on that switch; a merchant who is
  not VAT-registered must not be charged). **Ahmad to confirm** whether new stores should instead start
  with `taxEnabled = true`.
- Input parsing is strict: `'199.99'` → `19999`, `'1.999'` is **rejected** (CSV/XLSX product import,
  shipping-rate import, admin amount fields), never rounded.

## 1. Legacy `*Fils` / `*_fils` identifiers — kept on purpose (66 files)

`Fils` survives as an identifier suffix and in four DB columns. The values are **minor units** (piastres);
the name is historical. Renaming means a column-rename migration plus touching raw SQL, so it is deferred
(low risk to leave, high blast radius to change in this task).

| DB column / Prisma field              | Table                                                  |
| ------------------------------------- | ------------------------------------------------------ |
| `stock_value_fils` / `stockValueFils` | `deadstock_flags`                                      |
| `revenue_fils` / `revenueFils`        | `funnel_snapshots`, `store_usage_snapshots`            |
| `monetary_fils` / `monetaryFils`      | `customer_rfm_snapshots` (model `CustomerRfmSnapshot`) |
| `amount_fils` / `amountFils`          | `bank_transactions`                                    |

Other `*Fils` names are JSON settings keys (`minimumOrderFils`), API payload fields, local variables and
test fixtures. `region/index.ts` documents the convention. Follow-up task suggested: rename in one PR with
a `ALTER TABLE … RENAME COLUMN` migration.

## 2. Payment providers — SP6 (leave their KWD logic, replace with Egyptian adapters)

These are provider-specific and were deliberately **not** touched (apart from words in comments in
`payment.factory.ts` / `types.ts`):

| File                                                                               | KWD-specific spot                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/services/payment-providers/tap.provider.ts`                          | `request.amount / 1000`, `Math.round(x * 1000)` (charge, refund, webhook), `country_code: '965'`, `+965` phone strip, KNET source, `currency === 'KWD'` gating                                                 |
| `…/myfatoorah.provider.ts`                                                         | `amountInKWD = amount / 1000`, `UnitPrice / 1000`, `Math.round(InvoiceValue * 1000)` ×8, `InvoiceAmount: amount / 1000`, `'KWD'` fallbacks, `965XXXXXXXX` phone format, KNET                                   |
| `…/hesabe.provider.ts`                                                             | `/ 1000`, `Math.round(x * 1000)` ×4, `currency: 'KWD'`, KNET                                                                                                                                                   |
| `…/upayments.provider.ts`                                                          | `/ 1000`, `Math.round(x * 1000)` ×4, `payment_gateway: 'knet'`, "KNET only works with KWD"                                                                                                                     |
| `…/payment.factory.ts`                                                             | seeded default provider configs `supportedCurrencies: ['KWD', …]` (lines ~279–346); the `AMOUNT_TOLERANCE_FILS = 5` reconciliation allowance (kept at 5 minor units — a rounding allowance, not a money value) |
| `…/types.ts`                                                                       | `Currency` union still lists `'KWD'` (and now `'EGP'`)                                                                                                                                                         |
| `apps/api/src/routes/payment.routes.ts`                                            | static `supportedMethods: ['knet', 'visa', …]`                                                                                                                                                                 |
| `apps/api/src/services/onesignal.service.ts`                                       | `knet: 'KNET'` provider label                                                                                                                                                                                  |
| `apps/web/src/components/PaymentIcons.tsx`, `apps/web/src/app/cart/CartClient.tsx` | KNET icon / default "We accept" list                                                                                                                                                                           |
| `apps/api/src/lib/inngest/functions/bulk-ai-aeo.ts`                                | per-provider accepted-method name lists (KNET/Visa/…)                                                                                                                                                          |
| `apps/admin/src/i18n/messages/{en,ar}.json`                                        | `"knet": "KNET"` method label                                                                                                                                                                                  |
| `apps/api/src/lib/ai/eval/**`                                                      | eval fixtures mention KNET as an example payment method                                                                                                                                                        |

SP6 contract: every new adapter converts with `toMinor` / `fromMinor` (single `currencyExponent`), never a
literal `100`/`1000`; the factory's `Currency` union and default configs become EGP-first.

## 3. Shipping carriers — SP7

| File                                                   | Spot                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/services/carriers/aramex.carrier.ts:205` | `Value: data.codAmount / 1000, CurrencyCode: 'KWD'` — **fixed in SP7**: EGP from integer piastres, and refused until Aramex confirms EGP COD |
| `apps/api/src/services/carriers/types.ts`              | "Kuwait-specific" field comments; `value`/`codAmount` documented in fils — **fixed in SP7** (piastres)                                       |
| `apps/admin/src/i18n/messages/{en,ar}.json`            | Aramex `accountEntity` example `KWI` — **fixed in SP7** (`CAI`; Kuwait pickup fields replaced by Egypt ones)                                 |

## 4. Brand / marketing / legal copy — owned by the rebrand task (SP4 task 1) and SP9

Not touched, to avoid colliding with the concurrent rebrand: `apps/web/src/components/landing/*`
(Kuwait hero/CTA/stats copy, KNET + KWD feature blurb), `ui/flickering-footer.tsx` (+965 WhatsApp),
`apps/admin/src/components/FeatureUpgradeGate.tsx` and `…/floating-widget/page.tsx` (platform WhatsApp
numbers), `terms/TermsClient.tsx` + `privacy/PrivacyClient.tsx` (Kuwait governing law / address),
`app/layout.tsx` (not-found metadata), `app/llms.txt/route.ts` (platform + default store descriptions say
"Kuwait-based"; its currency lines **were** converted), `LocationsClient.tsx` (a country-name
translation table — Kuwait stays a valid entry), `store-layout.ts` / `template-baselines.ts` (citations of
Kuwait Law 39/2014 on fake reviews — a legal reference, correctly Kuwait), GCC data-protection comments.
Egypt equivalents (PDPL 151/2020, Egyptian consumer-protection law) belong to the legal pass.

## 5. FX table / exponent table — legitimate

`packages/shared/src/region/index.ts` (`KWD: 3` exponent entry, doc examples) and
`packages/shared/src/utils/accounting.ts` (`ALLOWED_CURRENCIES` keeps KWD/BHD/OMR etc. as foreign
currencies; the **base** is `REGION.currency`; `convertToBase` is exponent-aware).

## 6. Comments / examples only (no behaviour)

- `apps/admin/src/components/mobile/DataTable.tsx` — bidi example `+965 2222 3333`.
- `apps/admin/…/PaymentLinkButton.tsx`, `payment-providers/refund-outcome.ts`, `return.service.ts`,
  `partial-return-posting.ts` — "KNET timeout / KNET stays overstated" prose about gateway behaviour.
- `apps/api/src/routes/tax.routes.ts` — example "KW 5 % / SA 15 %" in a comment about multi-country rates.
- `apps/web/src/app/checkout/CheckoutClient.tsx` — comment contrasting `"KW"` vs `"Egypt"` country values.
- `packages/database/prisma/seed.ts` — says the demo prices were authored in KWD (scaled ×100 to EGP).
- `packages/database/prisma/schema.prisma` — one pre-existing sample comment per model.

## 7. Money-valued constants that were re-based (product to confirm)

These numbers meant "N KWD"; copying the digit would have shrunk them ~165×. Re-based to roughly the same
real-world value in EGP:

| Constant                                                               | FWB                                  | Ebda                                   |
| ---------------------------------------------------------------------- | ------------------------------------ | -------------------------------------- |
| `AffiliateConfig.minPayoutAmount` default (schema, migration, service) | 5 000 fils (5 KWD)                   | 50 000 piastres (500 EGP)              |
| `DEADSTOCK_VALUE_FILS_THRESHOLD`                                       | 50 000 fils (50 KWD)                 | 500 000 piastres (5 000 EGP)           |
| `REVENUE_DROP_MIN_FILS` (profit anomaly floor)                         | 50 000 fils / week                   | 500 000 piastres / week (5 000 EGP)    |
| Loyalty `pointsPerDinar` → `pointsPerMajorUnit` default                | 10 pts / KWD @ 1 fil/pt (= 1 % back) | 1 pt / EGP @ 1 piastre/pt (= 1 % back) |
| Seed demo prices                                                       | KWD-era numbers                      | ×100                                   |

Unchanged on purpose: payment-reconcile tolerances (5 minor units), `WALLET_MAX_ENTRY_FILS`
(100 000 000 minor units — a sanity bound well inside int32), `minPayout`-style UI defaults tied to points.

## 8. Behaviour changes worth a reviewer's eye

1. **Strict decimals.** `toMinor('1.999')` throws; XLSX/CSV product import turns a 3-decimal price into the
   sentinel `NaN` (the bulk validator then reports the row), shipping-rate import reports
   "invalid delivery fee", and the admin `majorToMinor` returns `null`. FWB rounded these silently.
2. **FX is exponent-aware.** FWB's `convertToKwd` treated every currency's minor unit as the same size
   (USD cents → KWD fils at the same scale — off by 10× for 2-vs-3-decimal pairs). `convertToBase(amount,
rate, currency)` / `convertMinor` apply `currencyExponent` of both sides. EGP↔USD (both 2 decimals) is
   numerically identical to before.
3. **Cairo has DST.** The nightly rollups used a fixed `UTC+3` offset (`KW_OFFSET_MS`); Egypt is UTC+2 in
   winter, UTC+3 in summer. Day/month boundaries now come from `regionDayStart` / `regionMonthStart`
   (Intl-based, DST-aware, a day can be 23 h), and Inngest crons use `TZ=Africa/Cairo`.
4. **Arabic is the default** (`resolveDefaultLanguage`): store settings, SSR `<html lang>`, emails,
   campaigns, newsletter and `LanguageContext` fall back to `ar` unless a store explicitly sets `en`.
   The admin i18n default locale is `ar`. (The Track-A tenant-routing env parser in `apps/web/middleware.ts`
   still defaults to `en`; it is an allowlisted experiment — untouched.)
5. **Provisioning defaults** were `USD`; now `REGION.currency` / `ar`, plus the 14 % VAT rate row.
6. **Foreign-currency display** in emails/invoices is now `USD 100.00` (shared `formatMoney`), not Intl's
   `$100.00`; EGP renders `EGP 1,299.50` / `1,299.50 ج.م`.
7. **Accounting COA** account `1000` is now "Cash Online" / `كاش مدفوعات إلكترونية` (was "Cash KNET");
   the code `1000` and `PROVIDER_TO_CASH_CODE` are unchanged.
8. **Checkout address form** is Egyptian: governorate → city/district, street, building no., floor,
   apartment, landmark (was block / avenue / house). The structured fields are now accepted by the
   shared address schema, the public order schema and the address book.

## 9. What changed (summary)

Prisma defaults (`EGP`, `Africa/Cairo`, `Egypt`, `مصر`, payout default) via the **new** migration
`20261003120000_ebda_egypt_defaults`; `region/` module + 27 governorates (+ `egypt-areas.ts`, replacing
`kuwait-areas.ts`); every `/ 1000`, `* 1000`, `toFixed(3)`, `Intl … 3 decimals`, `'KWD'`, `د.ك`, `ar-KW`,
`Asia/Kuwait`, `+965`, `KW` country-code literal outside the groups above; admin i18n copy (labels,
placeholders, examples); XLSX number formats (`excelMoneyFormat`); seed data; tests.
