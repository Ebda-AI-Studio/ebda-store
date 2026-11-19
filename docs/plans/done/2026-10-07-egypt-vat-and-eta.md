# Egypt VAT gating and ETA e-receipt / e-invoice — research and design

Status: DESIGN ONLY (no implementation code). Date: 2026-10-07. Owner: Ahmad.
Base: `origin/main` @ `a44df2b3`. Branch `docs/egypt-vat`.

Source-quality legend used throughout: **[P]** = primary source (ETA, official SDK, law text),
**[S]** = secondary (law-firm / vendor summary), **UNVERIFIED** = could not be confirmed from a
primary source in this pass. Anything marked UNVERIFIED must be settled before it drives code.

## 0. Ahmad's requirements (2026-10-07)

1. Egypt VAT is 14%. A merchant may collect VAT on its storefront only if it is a VAT-registered
   entity. VAT collection is OFF by default and can be enabled only after the merchant uploads
   proof (tax card / VAT certificate + tax registration number) and it is verified (super-admin
   review, plus automatic validation via ETA if an API allows it).
2. VAT-registered merchants' receipts/invoices carry the official ETA QR code (e-invoice for B2B,
   e-receipt for B2C).
3. Ebda itself (Whisky 11 / Ahmad) is NOT VAT-registered yet: no VAT on Ebda subscriptions. Any tax
   line in billing must sit behind an "Ebda is VAT-registered" platform setting that defaults OFF.

## 1. Executive summary

- **The gate Ahmad wants does not exist today.** `Store.taxEnabled` is a plain merchant-writable
  boolean (`PUT /stores/:storeId/tax/settings`, `apps/api/src/routes/tax.routes.ts:77`). Ruling
  TAX-1 (owner decision 2026-10-01) deliberately made the charge depend on `taxEnabled` alone. A
  14% VAT rate is also seeded on every new store (`store.service.ts:439`,
  `provisioning.service.ts:247`), so one toggle click from an unregistered home seller starts
  charging VAT. That is the exact failure Ahmad described, and the law treats it as tax evasion
  (section 2.1). There is one choke point to fix: `resolveActiveTaxRate`
  (`apps/api/src/lib/order-tax.ts:42`), which both order creation paths and both storefront
  payload builders already share.
- **Ebda billing adds no VAT today** (verified, section 3.2). Nothing to remove; we add a defaulted-OFF
  platform flag so a future registration is a switch, not a project.
- **ETA has a documented, free, direct-API model** (OAuth2 client credentials, 1h JWT, JSON documents).
  A platform CAN integrate on behalf of many merchants, but each merchant must first register
  the platform's system in their own ETA profile and hand over credentials; e-invoices (B2B)
  additionally need the merchant's own X.509 eSeal signature (USB token/HSM), which is the real
  blocker for B2B. E-receipts (B2C, Ebda's core flow) are far easier.
- **There is a public-ish TIN validation service**, but it is not in the e-invoicing SDK: it is the
  "Validate Taxpayer Registration Number" service of the ETA/MOF/e-finance **E-Commerce Taxes API
  Platform**, built for e-commerce platforms under the e-Commerce law, with an OTP sent to the
  taxpayer. Eligibility of a domestic platform like Ebda is UNVERIFIED; ask e-finance. Manual
  verification is the guaranteed baseline.
- Recommended order: (P0) ship the server-side gate + merchant tax profile + manual super-admin
  review; (P1) platform flag, TIN pre-validation, QR-less VAT display hardening; (P2) ETA e-receipt on
  preprod; (P3) per-merchant production rollout; (P4) B2B e-invoice only on demand.

## 2. Research findings (sourced)

### 2.1 VAT law: threshold, rates, who registers, penalties

| Fact                                                                                                                                                                                                                                                                                    | Source                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard rate 14% (13% FY2016/17, 14% from FY2017/18); machinery/equipment used in production 5%; exports zero-rated per Executive Regulations. Law 67/2016 Art. 3.                                                                                                                     | [P] ETA English translation of Law 67/2016 (updated 15 Jan 2023): https://www.eta.gov.eg/sites/default/files/2024-02/Law-english-no.67-2016.pdf.pdf                                                      |
| Registration: anyone selling taxable goods/services whose total taxable + exempt sales over the preceding 12 months reach or exceed **EGP 500,000** must apply within 30 days. The threshold "may be amended by a Ministerial decree". Art. 16.                                         | same [P]                                                                                                                                                                                                 |
| Voluntary registration below the threshold is allowed (Art. 18).                                                                                                                                                                                                                        | same [P]                                                                                                                                                                                                 |
| Natural persons who sell no goods/services need not register. Importers, exporters and distribution agents register regardless of turnover. Art. 16.                                                                                                                                    | same [P]                                                                                                                                                                                                 |
| **Issuing an invoice charged with VAT by a non-registrant is tax evasion** (Art. 68, item 8); failing to register on time is also evasion (Art. 68, item 1). Penalty Art. 67: 3 to 5 years imprisonment and a fine of EGP 5,000 to 50,000, or either; doubled on repeat within 3 years. | same [P]                                                                                                                                                                                                 |
| Registrants must issue invoices on taxable sales (Art. 68 item 6 makes failure evasion).                                                                                                                                                                                                | same [P]                                                                                                                                                                                                 |
| Law 67/2016 has been amended by Laws 66/2017, 208/2017, 329/2017, 13/2020, 3/2022, 24/2023, 177/2023, 157/2025. Law 157/2025 (in force from 18 Jul 2025) changed schedule rates and the scope of taxable items; ministerial decrees 417/418 of 2025 followed (effective 24 Oct 2025).   | [S] https://quaderno.io/guides/egypt-vat-guide/ , search summary of EY: https://taxnews.ey.com/news/2025-2316-egypt-introduces-significant-updates-to-vat-provisions (EY page lists no threshold change) |
| Exempt goods/services and Table Tax rates live in the law's attached schedules (not extracted in this pass). Table Tax is charged on top of VAT on listed items and, for some items, on the inclusive end-consumer price.                                                               | [P] law text, Art. 36 onward and the Table notes                                                                                                                                                         |

**Threshold conflict, UNVERIFIED.** The law text we could read says EGP 500,000. Several 2025-26
vendor articles (vatupdate, Wafeq, ohmyfin) say "Resolution No. 281 of 2025 reduced the mandatory VAT
and e-invoicing registration threshold to EGP 250,000, register by 31 Mar 2026". But Decision 281/2025
is documented by KPMG/Sovos as the **8th sub-phase of the e-receipt mandate** (named taxpayers from
15 Sep 2025), not a VAT threshold change, and EY's summary of 2025 amendments does not mention it.
Treat 250,000 as an unconfirmed rumour. Product impact is small: the gate keys on "is registered
and verified", not on turnover, so the number never enters code. It matters only for merchant
guidance copy ("you must register once turnover reaches ...") — keep that copy threshold-free or
cite the current figure from ETA at build time.

**Price display for consumers: UNVERIFIED.** No primary rule requiring VAT-inclusive consumer prices
was found in the VAT law text. Ebda already supports both modes (`Store.taxIncludedInPrice`,
frozen per order in `Order.taxIncludedInPrice`, ruling M3-7). Keep both; default new verified stores
to inclusive (consumer expectation) as a product choice, not a legal claim.

Other rates (UNVERIFIED): vendor pages mention a 10% rate for professional services and 5% rate lines;
per-product rate classes are out of scope. The existing model sums active `TaxRate` rows
(TAX-1). A merchant selling exempt or zero-rated goods needs per-product treatment; defer (open
question Q5).

### 2.2 ETA mandates (e-invoice and e-receipt) and phases

- **E-invoice (B2B/B2G)**: phased 15 Nov 2020 (134 large taxpayers) through 2021, real-time clearance
  from 2023, universal for registered businesses and paper invoices invalid for VAT from 1 Jul 2023;
  legal basis Ministerial Decree 188/2020 and Law 206/2020. [S] https://www.vatupdate.com/2026/02/23/briefing-document-podcast-e-invoicing-e-reporting-in-egypt/
- **E-receipt (B2C)**: pilot Apr 2022; Stage 1 from 1 Jul 2022 (153 large retailers); Stage 2 rolls
  out in sub-phases by **named taxpayer lists in ETA decisions** (e.g. ETA Resolution 405/2024 for
  15 Jan 2025; Decision 281/2025 for 15 Sep 2025; Decision 361/2025 first sub-phase of phase 9 for
  15 Nov 2025). Taxpayers check their obligation on the ETA site. [S] KPMG
  https://kpmg.com/us/en/taxnewsflash/news/2025/07/tnf-egypt-new-taxpayers-required-to-comply-with-mandate-to-issue-electronic-receipts-for-b2c-transactions.html ,
  Sovos https://sovos.com/regulatory-updates/global-vat/egypt-tax-authority-extends-e-receipt-obligations-for-b2c-transactions/
- **Submission window**: the SDK says a receipt must be submitted within **24 hours** of issuance
  (later via a Late Submission Request) [P]
  https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/ . Vendor pages say 72 hours as of 2025 [S]; use 24h
  as the hard internal SLA.
- **Simplified regime**: [S] ETA reportedly confirmed in Mar 2026 that businesses on the Law 6/2025
  simplified regime (turnover under EGP 20m) must use e-invoice/e-receipt. UNVERIFIED.
- **Penalties** [S, UNVERIFIED]: fixed fines and per-document fines for late submission.

Key implication: **e-receipt is mandatory per named taxpayer, not per merchant category**, so Ebda
must not assume "VAT-registered = must submit receipts". Model it as a per-store ETA mode
(`off | optional | required`) set from the merchant's own confirmation and, where possible, ETA's
obligation lookup (UNVERIFIED API; the check is a web page).

### 2.3 ETA API mechanics (official SDK, https://sdk.invoicing.eta.gov.eg)

Environments [P] (SDK FAQ https://sdk.invoicing.eta.gov.eg/faq/):

|                     | PreProd                                  | Production                       |
| ------------------- | ---------------------------------------- | -------------------------------- |
| Registration portal | https://profile.preprod.eta.gov.eg       | https://profile.eta.gov.eg       |
| Invoicing portal    | https://preprod.invoicing.eta.gov.eg     | https://invoicing.eta.gov.eg     |
| System API          | https://api.preprod.invoicing.eta.gov.eg | https://api.invoicing.eta.gov.eg |
| Identity            | https://id.preprod.eta.gov.eg            | https://id.eta.gov.eg            |

PreProd needs the ETA root CA installed (FAQ) and a Postman collection is provided: a real sandbox
exists. Sandbox onboarding still needs an ETA PreProd taxpayer profile; UNVERIFIED how fast ETA
provisions one for a software vendor.

**Onboarding** [P] https://sdk.invoicing.eta.gov.eg/start/ : taxpayer registers a digital profile,
invites representatives, **registers one or more ERP/POS systems and gets API credentials (client id
and secret)**, and for e-invoice an eSeal X.509 certificate for signing.

**Authentication** [P]:

- E-receipt: `POST {identity}/connect/token`, `grant_type=client_credentials`, `client_id`,
  `client_secret`, headers `posserial`, `pososversion`, `posmodelframework`, `presharedkey`. Token
  lasts 3600 s. Only taxpayers with the **B2C tag** can submit receipts.
  https://sdk.invoicing.eta.gov.eg/ereceiptapi/01-authenticate-pos/
- E-invoice: same endpoint with Basic auth. **Intermediary model**: add header `onbehalfof` =
  taxpayer registration number; "permissions granted by the taxpayer will be applied on your
  profile" and limit what you can do for them.
  https://sdk.invoicing.eta.gov.eg/api/01-login-as-taxpayer-system/

**Can Ebda submit on behalf of many merchants? Yes with conditions.**

1. E-invoice: documented intermediary login (`onbehalfof`), one Ebda credential plus a per-merchant
   grant in the merchant's ETA profile. [P]
2. E-receipt: the SDK states "the issuer Id must be the same in the token (submitter of the document
   must be the issuer)" and the POS must be registered and linked to the issuer RIN; error
   `IncorrectSubmitter` exists. The e-receipt auth page documents only the merchant's own
   POS credentials. So the safe model is **per-merchant credentials**: each merchant registers "Ebda"
   as an ERP/POS in its own ETA profile and gives Ebda the client id/secret/POS serial. Whether an
   intermediary token works for receipts is UNVERIFIED; test on PreProd. [P] https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/
3. A solution provider can be registered in the taxpayer's digital profile ([S] Comarch/Sovos wording
   "taxpayers can register one or more solution providers"); matches the start page.

**Signing** [P] https://sdk.invoicing.eta.gov.eg/signature-creation/ :

- E-invoice documents: canonicalise, SHA-256, **CAdES-BES signature with an X.509 eSeal certificate**
  embedded as Base64. The private key is issued on a **USB crypto-token/HSM** held by the taxpayer
  (vendor write-ups on cloud signing servers exist, e.g. SAP community post), so a multi-tenant
  platform cannot sign B2B invoices without the merchant's token or a merchant-authorised remote
  signing service. This is the dominant cost/complexity item.
- E-receipt: the submit API says "At least signature of the Issuer must be present, signature of the
  Service provider is optional", CAdES-BES, but also "the function to perform signature validation
  will not be deployed at this point", and the Integration Toolkit says "Signing the submission is not
  required as this feature is disabled". Current enforcement is therefore UNVERIFIED: build the
  signing seam but expect to ship unsigned receipts first, then switch on when ETA enforces.
  https://sdk.invoicing.eta.gov.eg/ereceiptapi/02-submit-receipt/ and
  https://sdk.invoicing.eta.gov.eg/toolkit/home/

**E-receipt document** (Receipt v1.2, type `s`) [P] https://sdk.invoicing.eta.gov.eg/documents/receipt-v1-2/ :
header (dateTimeIssued, receiptNumber unique per branch within a submission, uuid, previousUUID,
currency), documentType, seller (rin, trade name, branch code, address, device serial, activity
code), buyer (type B/P/F; id/name required depending on type and amount), itemData lines (internal
code, description, item type/code, unit, quantity, price, taxes), paymentMethod, totalSales,
netAmount, totalAmount, optional taxTotals/discounts. `uuid` = SHA-256 hex of the serialised receipt
without the uuid; `previousUUID` chains receipts per POS ("empty string accepted" for the first);
`referenceOldUUID` supports resubmission. Return Receipt v1.2 exists for refunds.

**Submission** [P]: `POST /api/v1/receiptsubmissions`, JSON `{receipts:[...], signatures:[...]}`,
HTTP 202 with `submissionUUID` and accepted/rejected lists; errors `BadStructure`,
`IncorrectSubmitter`, `MaximumSizeExceeded`, `DuplicateSubmission`. The batch size limit is not
quantified on the page (UNVERIFIED; do not batch over a conservative 50 until measured).

**QR code on the receipt** [P] https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/ (and toolkit QR page
https://sdk.invoicing.eta.gov.eg/toolkitapi/05-qrcode/): the taxpayer generates a QR encoding a URL to the
receipt in the e-invoicing portal:
`{portal}/receipts/search/{uuid}/share/{dateTimeIssuedUTC}` and the one-line payload
`{URL}#Total:{total},IssuerRIN:{registrationNumber}`. Example from the SDK:
`http://invoicing.eta.gov.eg/receipts/search/68e656b2...f320/share/2022-02-19T02:00Z`. So the QR
exists only after ETA has assigned/accepted the receipt, and it carries the UUID that ETA validates;
it cannot be minted offline before submission without risk. (The toolkit does generate it offline
from the locally computed UUID, so a pre-print QR is possible; the link only resolves after
acceptance.)

**Rate limits** [P] https://sdk.invoicing.eta.gov.eg/apigovernance/ : read APIs only are quantified per
ERP/POS system: Get Receipt 2 req/s, Get Receipt Details 2/s, Search Receipts 2/s, Get Recent
Receipts 3/s; e-invoice Get Document 2/s, printout PDF 1 per 5 s, Search 2/s. **HTTP 429**: retry
after the `Retry-After` header; **503**: retry after 1-3 s. The submit API's limit is not published.
Rate limits are per ERP/POS system, which strongly favours per-merchant credentials (each merchant
gets its own budget).

**Cost to call ETA**: no API fees documented anywhere in the SDK (absence, not an explicit statement;
UNVERIFIED as a negative). Costs are around the merchant's certificate and tokens (section 9).

### 2.4 Is there an ETA taxpayer lookup / TIN validation API?

- **In the e-invoicing/e-receipt SDK: no.** The Common, e-Invoicing and e-Receipt API lists contain
  no taxpayer or TIN lookup. [P] https://sdk.invoicing.eta.gov.eg/api/ , /einvoicingapi/ , /ereceiptapi/
- **Yes, a separate service**: "Validate Taxpayer Registration Number (TIN) Service" in the
  **E-Commerce Taxes APIs Platform**, built by e-finance with MOF and ETA "as per the e-Commerce Law
  and regulations" for e-commerce platforms. Flow: (1) simplified tax registration for e-commerce,
  (2) register to the Validate Taxpayer Registration service, (3) modify the platform, (4) call the APIs.
  Sequence: platform sends TIN, the platform receives "TIN details", **an OTP message goes to the
  customer (taxpayer)**, the platform submits the OTP, receives validation confirmation. Support:
  ecommerce_support@efinance.com.eg; materials: user guide, APIs SDK guide, test data, test
  environment. [P] https://www.eta.gov.eg/sites/default/files/2023-06/20230619_e-commerce_tax_api_platform.pdf
  and the ETA ecomSDK page https://eta.gov.eg/en/ecomSDK (which also hosts a SDK, an API collection
  and "Tax Registration Number Verification" materials; the page frames users as non-resident
  e-commerce platforms).
- Eligibility of a domestic platform (Ebda, Whisky 11 as a not-yet-VAT-registered company) and any
  fees: UNVERIFIED. This is open question Q2 and the single most useful email to send.
- There is also an ETA web page to check whether a supplier is in the e-invoice system
  (https://eta.gov.eg/ar/registered). It returned 403 to our fetch, so its function is UNVERIFIED;
  reviewers can use it manually.
- Important property of the OTP design: it proves that **the person typing the TIN controls the
  phone/email ETA has on file for that taxpayer**, which a PDF upload cannot prove. Use it as
  Tier-1 evidence when available; keep the document review as the fallback and the audit trail.

### 2.5 Competitor behaviour (thin, mostly UNVERIFIED)

Searches found no primary documentation for Zid, YouCan, ExpandCart, Wuilt or Shopify's Egypt-specific
ETA handling. What we could confirm:

- **Salla (KSA)**: merchant enters an establishment VAT number and uploads the VAT certificate image
  in Store settings > VAT; both are shown in the store footer; the number is rejected unless it has
  16 digits and starts and ends with 3 (KSA-specific format validation). That is display plus format
  check, not an approval workflow. [P-vendor] https://help.salla.sa/en/article/show-salla-vat-number-store-footer/ifksoy8x9ln5ec31lnrmbldb
- **Egypt ERP ecosystem** (Odoo, ERPNext, Daftra) integrates ETA through per-company credentials and
  an ERP-registered client id/secret; this is the proven pattern, not an e-commerce builder one.
  [S] https://docs.ecosire.com/odoo-modules/egypt-eta-einvoicing , https://docs.daftra.com/en/user_manual/integrating-daftra-with-the-egyptian-tax-authority-eta/
- Zid, YouCan, ExpandCart, Wuilt, Shopify Egypt: **UNVERIFIED**. Do a hands-on sign-up of two of them
  before positioning Ebda's "verified VAT + ETA receipts" as differentiation.

## 3. Current-code survey (origin/main @ a44df2b3)

### 3.1 Tax fields, settings, calculations

| What                                                                                                                                 | Where                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store switches: `taxEnabled` (default false), `taxIncludedInPrice` (default false), legacy `defaultTaxRate` (not read by the charge) | `packages/database/prisma/schema.prisma:290-292`                                                                                                                                                                                                                                             |
| Accounting default `defaultTaxRateBps` (default 0), unrelated to the storefront charge                                               | `schema.prisma:381`                                                                                                                                                                                                                                                                          |
| `TaxRate` model (name, rate Decimal(5,2), country/state/priority/isCompound ignored by the charge, isActive)                         | `schema.prisma:2701`                                                                                                                                                                                                                                                                         |
| Per-order frozen convention `Order.taxIncludedInPrice`                                                                               | `schema.prisma:1333` (migration `20260927130000_order_tax_included_in_price`)                                                                                                                                                                                                                |
| Order money field `orders.tax`                                                                                                       | initial migration `...20241227000000_initial_schema/migration.sql:177`                                                                                                                                                                                                                       |
| Expense and PO tax (input VAT, merchant purchases)                                                                                   | `schema.prisma:3599` (PurchaseOrder.taxAmount), `3766` (Expense.taxAmount), migration `20260519210000_accounting_batch_2`                                                                                                                                                                    |
| **The single charge resolver**: `resolveActiveTaxRate(storeId)` returns the SUM of active rates when `Store.taxEnabled`, else 0      | `apps/api/src/lib/order-tax.ts:42-61`                                                                                                                                                                                                                                                        |
| Formula (VAT after discount; inclusive extraction `base*bps/(10000+bps)`)                                                            | `packages/shared/src/region/index.ts:163-171`, wrapper `packages/shared/src/order-tax.ts:25-36`, `REGION.defaultVatBps = 1400` at `region/index.ts:99`                                                                                                                                       |
| Rulings                                                                                                                              | `docs/RULINGS.md` M3-3, M3-6..M3-9, TAX-1 (line 4615), TAX-1a. TAX-1 states "VAT collection is a legal obligation, not a billing feature" and charges on `taxEnabled` alone; prod had 0 `tax_rates` rows and `taxEnabled: false` on every live store at the time (re-check before migrating) |

### 3.2 Every place a tax line can be PRODUCED

| Path                                                            | File:line                                                                                                                                                                                                                                                                          | Uses resolver?      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Public checkout order creation                                  | `apps/api/src/services/order.service.ts:810` (resolve), `:1001` (`computeOrderTax`), `:1386` (freezes `taxIncludedInPrice`)                                                                                                                                                        | yes                 |
| Admin-created order                                             | `order.service.ts:2525` (resolve), `:2655` (compute), `:2763` (freeze) in `createAdminOrder` (`:2408`)                                                                                                                                                                             | yes                 |
| Storefront payload for cart/checkout (display)                  | `apps/api/src/routes/public.routes.ts:1571` and `:1743` (`taxRatePercent`) ; the web side recomputes with the same formula at `apps/web/src/app/checkout/CheckoutClient.tsx:1076-1078`, `apps/web/src/app/cart/CartClient.tsx:368-370`, label in `apps/web/src/lib/tax-display.ts` | yes (display)       |
| Payment links draft order                                       | `apps/api/src/routes/payment-links.routes.ts:288` hard-codes `tax: 0`                                                                                                                                                                                                              | n/a, no tax         |
| Refunds/returns re-use the frozen order values                  | `return.service.ts:1206-1234`, `:1475-1486`; GL `accounting/posting/order-posting.ts:126-182` (Tax Payable 2100), `partial-return-allocation.ts`                                                                                                                                   | consume `order.tax` |
| Tax report (VAT per period from the ledger)                     | `apps/api/src/services/accounting/tax-report.service.ts`; admin `apps/admin/src/app/stores/[id]/finance/reports/page.tsx`                                                                                                                                                          | derived             |
| Removed second resolver (`POST /public/:storeId/tax/calculate`) | `tax.routes.ts:236-243` comment, issues 2211/2167                                                                                                                                                                                                                                  | gone                |
| Store/agent surfaces (MCP)                                      | grep of `apps/api/src/mcp` shows read-only `tax` echo (`mcp/tools/admin-read.tools.ts:364`) and no tax-settings writer                                                                                                                                                             | n/a                 |

### 3.3 Who can turn VAT on (the gap)

- `PUT /stores/:storeId/tax/settings` (`tax.routes.ts:77`, `authorize('store_admin','super_admin')`)
  validates `{taxEnabled, taxIncludedInPrice}` with a strict zod schema (`tax.routes.ts:35-36`) and calls
  `TaxService.updateSettings` (`apps/api/src/services/tax.service.ts:71-93`), which writes
  `taxEnabled` straight to `stores` and busts the public tax caches (`bustPublicTaxCaches`).
  No registration check exists. This is the only writer of `taxEnabled` in `apps/api` (grep of
  `taxEnabled` across routes/services/mcp).
- Admin UI toggle: `apps/admin/src/app/stores/[id]/tax/_components/TaxGeneralSettings.tsx:38-42`,
  page `apps/admin/src/app/stores/[id]/tax/page.tsx`; rate CRUD in `TaxRatesTable.tsx` /
  `TaxRateFormModal.tsx`.
- Store creation seeds an ACTIVE 14% "VAT" `TaxRate` (`store.service.ts:433-446`,
  `provisioning.service.ts:244-252`); comments say the merchant "has to flip `taxEnabled` once
  VAT-registered". That intent was never enforced.
- Merchant-facing copy, `docs/merchant/*` and `docs/legal/*`: no VAT-registration guidance exists
  (the only tax mentions in `docs/legal` are data-retention rows).

### 3.4 Invoice / receipt templates

- HTML invoice: `apps/api/src/services/invoice.service.ts` (totals block `:640-660`, EN/AR labels
  `:59-60`, `:88-89`); status badge `:726`; email variant `:927`. Tax row shows only when
  `taxPlacement.taxRow > 0`; inclusive VAT prints as an "Incl. VAT" caption (`order-tax-display.ts`).
- Order confirmation email: `apps/api/src/services/email-templates/order-confirmation.ts:13,24,89`,
  type `email.service.ts:240-244`.
- Orders app labels: `apps/orders/src/i18n/messages.ts:334,568`; order export column
  `apps/api/src/routes/order.routes.ts:179,258,333`.
- **Missing everywhere**: seller tax registration number, buyer data, "tax invoice" wording, ETA
  UUID/QR. An invoice carrying a VAT line without the seller's registration number is also not a
  valid tax invoice, a second reason to gate.

### 3.5 Subscription billing: no VAT (verified)

`grep -iE "vat|tax"` over `apps/api/src/services/billing/*.ts`, `routes/billing*.ts`,
`email-templates/subscription-billing.ts` and `lib/inngest/functions/billing-renewal.ts` returns only
the TypeScript keyword `private`. The amount charged is the plan price alone:
`subscription-billing.service.ts:474-485` (`priceFor(plan, interval)`, rejects null/non-positive) and
`:530,542` (`amountMinor: price`); renewals `:629-631`; the Kashier/stub providers take
`amountMinor` integers (`billing/types.ts:25,44,64,91`). No tax column on any subscription, plan or
billing event. So the Ebda requirement is already met; the work is to make that explicit and
future-proof (section 5.8).

## 4. Design principles

1. **Registered status is a fact about the merchant, stored once, enforced at the resolver.** UI
   hiding is cosmetic; the server never produces a tax line for an unverified store.
2. **Fail closed.** Any unknown/expired/suspended state means 0% VAT. A store silently stopping VAT
   is a visible, recoverable problem; a store charging VAT unlawfully is a criminal-exposure problem.
3. **Verification evidence is append-only and auditable** (who, when, what document, which check).
4. **ETA integration is an optional, later layer** on top of verified VAT; the gate must ship
   without it.
5. Reuse what exists: `resolveActiveTaxRate`, `bustPublicTaxCaches`, `encryption.service`, Inngest,
   R2 uploads, super-admin pages in `apps/admin`, audit log.

## 5. Proposed design

### 5.1 Data model (Prisma, new migration; all money stays integer minor units)

```
enum TaxVerificationStatus { not_submitted pending_review verified rejected suspended expired }
enum TaxDocumentKind { tax_card vat_certificate commercial_register other }
enum TaxEntityType { individual company }
enum TaxVerificationMethod { manual_review tin_otp }

model StoreTaxProfile {            // 1:1 with Store (storeId @unique)
  id, storeId @unique
  status            TaxVerificationStatus @default(not_submitted)
  entityType        TaxEntityType?
  legalName         String?
  taxRegistrationNumber String?   // RIN/TIN; Egypt TIN is 9 digits per [S] lookuptax; validate shape, not length rules we cannot prove
  vatRegistered     Boolean       @default(false)  // merchant's claim; verified only via status
  vatEffectiveFrom  DateTime?     // date the verification takes effect; no VAT before it
  validUntil        DateTime?     // re-verify annually (UIN-style expiry in ETA ecom flow)
  verifiedBy        String?  verifiedAt DateTime?
  verificationMethod TaxVerificationMethod?
  rejectionReason   String?
  submittedAt       DateTime?
  @@unique([taxRegistrationNumber])  // one TRN, one store; collision -> forced review
}
model StoreTaxDocument {           // evidence files; private R2 objects
  id, storeId, kind TaxDocumentKind, r2Key, sha256, mime, sizeBytes, uploadedBy, uploadedAt, supersededAt?
}
model StoreTaxVerificationEvent {  // append-only audit trail
  id, storeId, at, actorUserId?, actorKind (merchant|super_admin|system), fromStatus, toStatus,
  reason?, metadata Json   // e.g. tin_otp result, reviewer note, document ids
}
model PlatformSetting { key String @id, value Json, updatedBy, updatedAt }  // e.g. ebda.vatRegistered=false
```

`Store.taxEnabled` stays (merchant on/off preference) but **its meaning changes to "merchant wants
to collect"**; effective collection is `taxEnabled AND profile.status = verified AND now >=
vatEffectiveFrom AND (validUntil is null OR now < validUntil)`. New tables get RLS exactly like
`tax_rates` (see `20260609000000_complete_force_rls_coverage`, `20261004000000_ebda_strict_rls`) and
`FORCE ROW LEVEL SECURITY` coverage tests; add FK-cascade handling per the delete-handler rule
(`docs/RULINGS.md` FK sweep), including R2 object cleanup via `lib/r2-references.ts`.

ETA layer (P2+):

```
model StoreEtaConnection {         // per merchant
  id, storeId @unique, mode (off|optional|required), environment (preprod|prod),
  clientIdEnc, clientSecretEnc, posSerial, posOsVersion, posModelFramework, preSharedKeyEnc,  // encryption.service AES-256-GCM
  branchCode, activityCode, issuerRin (must equal profile.taxRegistrationNumber),
  lastTokenAt, lastOkAt, lastErrorCode?, disabledAt?
}
model EtaReceiptSubmission {       // one row per order document version
  id, storeId, orderId, kind (receipt|return), seq, status (queued|submitted|accepted|rejected|failed|late),
  uuid, previousUuid, referenceOldUuid?, longId?, submissionUuid?, dateTimeIssuedUtc,
  payload Json, qrUrl?, attempts, nextAttemptAt, lastError?, acceptedAt?
  @@unique([storeId, orderId, kind, seq])
}
```

Order gets `etaStatus` / `etaUuid` read through the submission row, not duplicated columns.

### 5.2 The gating rule, enforced server-side at every place a tax line can be produced

One function owns it, in `apps/api/src/lib/order-tax.ts`:

`resolveActiveTaxRate(storeId)` additionally selects the store's `StoreTaxProfile` (one extra
select in the existing `Promise.all`) and returns `ratePercent: 0` unless the **collection predicate**
holds. Because every existing charge and display path already calls it, the following are all gated
without further edits: order creation `order.service.ts:810`, admin order `:2525`, storefront
payloads `public.routes.ts:1571,1743`, and the web checkout/cart (which receive a zeroed
`taxRatePercent`). Defence in depth (all required, each with a test):

1. **Resolver** (above): the authoritative gate.
2. **Write gate**: `TaxService.updateSettings` (`tax.service.ts:71`) and `PUT .../tax/settings`
   (`tax.routes.ts:77`) reject `taxEnabled: true` with `409 TAX_NOT_VERIFIED` unless the profile is
   verified; `taxEnabled: false` is always allowed. Rate CRUD stays allowed (the rows are inert).
3. **Seed**: keep the seeded 14% row but inactive-by-effect; no change to `store.service.ts:439` /
   `provisioning.service.ts:247` is required, but update their comments (they currently describe a
   merchant-flips-it flow).
4. **Order freeze**: persist the effective rate decision on the order at creation (a `taxCollected`
   boolean or reuse `tax > 0`), so later suspension never rewrites history. Refund/return flows keep
   reading the frozen `order.tax`.
5. **State transitions** (`verified -> suspended|expired`, merchant deletes a document, super-admin
   revokes) call `bustPublicTaxCaches(storeId)` and write a verification event; cache staleness class
   for this value is NEVER-stale (permissions/entitlements class), so the invalidate must be called
   from every writer: profile service, admin revoke, expiry sweep (Inngest cron), store
   suspend/delete.
6. **Migration/backfill** for existing stores: any store with `taxEnabled = true` and no verified
   profile is set to `taxEnabled = false` and notified, **after** reading production first (TAX-1
   recorded 0 stores enabled; verify with a read-only SELECT before and after deploy). Capture as a
   new ruling "TAX-2 supersedes TAX-1's 'taxEnabled alone'" in `docs/RULINGS.md`, with the cost-if-wrong
   line (a verified merchant loses VAT collection if the profile lapses; mitigated by expiry warnings
   30 days ahead).
7. **Invoices/emails**: never print a tax row or "Incl. VAT" when the order was not collected under a
   verified profile; print the seller's registration number only for verified stores.
8. **Tests (mutation-proved)**: store with `taxEnabled=true` and each non-verified status yields
   `tax = 0` on all four producers; flipping each status back to verified restores the charge;
   a negative control proves the test fails if the profile join is removed.

### 5.3 Merchant flow (admin app, store settings > Tax)

1. Tax page shows a status banner: Not VAT-registered (default), Under review, Verified (since,
   until), Rejected (reason), Suspended. The toggle and rate editor are disabled with an explanation
   unless Verified.
2. "Enable VAT collection" wizard: entity type, legal name, tax registration number, upload tax card
   and/or VAT certificate (PDF/JPG/PNG, size cap, magic-byte check, virus scan per the upload
   pipeline, private R2, never public URLs), attest "I am VAT-registered with the Egyptian Tax
   Authority" (stored with timestamp and IP in the event row).
3. Optional Tier-1: "Verify with ETA" (OTP) when the e-finance service is available (section 5.5).
4. Submission moves status to `pending_review` and emails support/super-admin; the merchant gets an
   email on approve/reject (EN + AR templates).

### 5.4 Super-admin verification UI

New super-admin-only page in `apps/admin` (pattern: `apps/admin/src/app/ai-usage/page.tsx` route
guard), e.g. `/tax-verification`: queue of `pending_review` with age, side-by-side document viewer
(short-lived signed URLs), merchant-entered TRN vs OCR hints (optional later, reuse the expense OCR
service), checklist (name matches store legal entity, TRN not used by another store, certificate not
expired, activity matches), buttons Approve (sets `vatEffectiveFrom`, `validUntil` = +12 months),
Reject (reason required), Suspend/Revoke later. Every action writes an event and an audit-log row;
actions need MFA-enabled super-admin (existing `account/security` MFA status). Duplicate-TRN
collisions force a manual flag.

### 5.5 Automatic validation tiers

| Tier | Method                                                                                   | Status                                                                            |
| ---- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| T0   | Format check on TRN shape, uniqueness per store, document presence                       | always on                                                                         |
| T1   | e-finance/ETA "Validate Taxpayer Registration Number" API with OTP to the taxpayer       | UNVERIFIED eligibility; request access (Q2); gives TIN details + proof of control |
| T2   | Reviewer opens the ETA "registered" web page manually (https://eta.gov.eg/ar/registered) | manual, function UNVERIFIED                                                       |
| T3   | Document review by super-admin                                                           | baseline, mandatory until T1 is proven                                            |

Policy: T1 passing does not auto-approve at first; it pre-fills the review and raises priority. After
a trial period (e.g. 50 clean reviews) consider auto-approve when T1 returns "registered and active"
and the legal name matches. Store the raw T1 response in event metadata; never log OTPs.

### 5.6 Checkout, invoice and receipt changes

- **Checkout/cart**: no code change needed beyond the resolver (they already render `taxRatePercent`
  from the API and show no VAT line at 0). Add an e2e: unverified store shows no VAT row and total =
  subtotal - discount + shipping.
- **Invoice** (`invoice.service.ts`): for verified stores add seller legal name, tax registration
  number, "Tax invoice / فاتورة ضريبية" heading, tax breakdown; for unverified stores keep "Invoice"
  with no tax wording at all. If ETA mode is on and the submission is accepted, add the QR block
  and the ETA UUID; otherwise show "pending ETA registration" state internally, not to the buyer.
- **Order confirmation email and orders app**: mirror the above (`order-confirmation.ts`, `apps/orders`
  messages).
- **Buyer data**: ETA B2C receipts need buyer type `B` (anonymous consumer) and only require
  identification above amount thresholds (UNVERIFIED thresholds; read the receipt schema notes during
  P2). Do not collect national IDs by default; PII rules apply.

### 5.7 ETA integration architecture (P2+)

```
order paid/confirmed (Inngest event, existing order-created / payment flows)
  -> eta-receipt-build  (pure mapper: Order+lines+store profile -> Receipt v1.2 JSON, uuid = sha256)
  -> eta-receipt-submit (Inngest function)
        concurrency: 1 per storeId   // previousUUID chain must be ordered per POS
        steps: token (cache per store, refresh at 55 min) -> POST /api/v1/receiptsubmissions
        retries: 503 -> 1-3 s backoff; 429 -> Retry-After; 5xx/network -> exponential up to 20 h;
                 hard deadline = issue time + 24 h, then mark `late` and alert (Late Submission Request is manual)
        idempotency: unique (storeId, orderId, kind, seq); DuplicateSubmission -> reconcile via Get Receipt
  -> eta-receipt-reconcile (cron) polls Get Recent Receipts within the 2-3 req/s limits
  -> on accepted: store longId, build QR URL, bust order/invoice caches, email/receipt shows QR
refund/return -> Return Receipt v1.2 referencing the original uuid (new seq)
```

- **Credentials**: per merchant, never shared. The merchant registers "Ebda" as an ERP/POS in the ETA
  profile, pastes client id/secret/POS serial/pre-shared key in admin. Stored with
  `encryption.service` (AES-256-GCM, same as TOTP/payment config), masked on read like
  `marketing-pixels-secrets.ts`, never returned to the browser, redacted in logs and Sentry.
  Decrypt only inside the worker; `safe-decrypt-json.ts` pattern.
- **Intermediary option (e-invoice, maybe receipts)**: one Ebda credential plus `onbehalfof=<merchant
RIN>` after the merchant grants permission. Test on PreProd; adopt only if receipts accept it,
  because it removes the copy-paste of secrets and gives one rotation point.
- **Signing seam**: `ReceiptSigner` interface with a `NoopSigner` (current enforcement) and a
  `CadesBesSigner` that calls a merchant-authorised remote signing service. Do not hold merchants'
  eSeal private keys. For B2B e-invoice (P4) each merchant needs their own eSeal and signing
  endpoint; Ebda offers a guided "bring your own signing service" connector, not a hosted HSM, until
  there is demand and a legal/CA agreement (UNVERIFIED whether CAs allow remote HSM seals for
  third-party platforms).
- **Environments**: `preprod` vs `prod` per connection; the QR host follows the environment; never
  allow a preprod connection on a live store's customer-facing receipts.
- **Observability**: per-store submission funnel (queued/accepted/rejected/late) in the existing alert
  pipeline; alert on any rejection spike and on 20 h-old unsubmitted receipts.
- **QR rendering**: build the string `{portal}/receipts/search/{uuid}/share/{dateTimeIssuedUTC}#Total:{total},IssuerRIN:{rin}`
  server-side, render as SVG QR (no new heavy dependency; prefer a small audited library, check
  with `srcof`, license, <12 months). Shown on the HTML invoice, order confirmation email and the
  order status page; PDF printouts via the existing invoice HTML.

### 5.8 Subscription billing: no VAT behind a platform flag

- Add `PlatformSetting ebda.vatRegistered` (default `false`) and, only for the future, `ebda.vatRegistrationNumber`
  and `ebda.vatRateBps` (default 1400). A tiny `getPlatformVat()` helper reads it (cached; invalidate on
  change) and returns `{ enabled:false }` when unset.
- Billing today charges `price` (`subscription-billing.service.ts:497-542`). When the flag is ON the
  billing service would compute `vatOnDiscounted` via the shared helper and charge
  `price + vat` (Ebda plan prices are set exclusive or inclusive; decision Q4), persist the split on
  the billing event/subscription invoice and show it on the invoice email. When OFF (default) there is
  no tax column populated, no tax line rendered, and a unit test asserts `amountMinor === price` and no
  `tax` key in the provider call.
- Legal side belongs with the accountant, not code: a company that exceeds the threshold must register
  or it is "failure to register" evasion (Art. 68 item 1). Ebda revenue should be tracked against the
  threshold; see Q1. Once registered, subscriptions to registered merchants are B2B and need ETA
  e-invoices signed with Whisky 11's own eSeal (P4 scope for Ebda itself).
- Super-admin toggle with audit event and confirm dialog; flipping ON in production requires a
  registration number on file.

## 6. Phased plan

| Phase                         | Scope                                                                                                                                                                                                                                           | Exit evidence                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 Gate (about 1 week)        | Schema + RLS, profile/document/event services, resolver gate, write gate, backfill + prod read-only check, merchant tax page states, super-admin review queue, EN/AR emails, TAX-2 ruling, tests incl. mutation negative control, merchant docs | Prod SELECT shows 0 stores collecting without verified profile; e2e unverified store charges 0 on every producer; reviewer can approve/reject |
| P1 Platform flag + validation | `PlatformSetting`, billing flag + test, e-finance TIN OTP access request and, if granted, T1 integration; invoice seller block (registration number, tax invoice heading)                                                                       | Billing amount equals plan price; T1 works on e-finance test env                                                                              |
| P2 ETA PreProd e-receipt      | Per-store connection (encrypted), mapper, queue, QR renderer, reconcile, noop signer, PreProd account + test merchants                                                                                                                          | 100 PreProd receipts accepted incl. return receipts; 429/503 chaos test; QR resolves on PreProd portal                                        |
| P3 Production rollout         | Per-merchant opt-in with `mode`, runbook, alerts, docs, 24 h SLA watch; pilot with 1-2 real registered merchants                                                                                                                                | Live receipts visible in ETA portal; zero late submissions over 2 weeks                                                                       |
| P4 B2B e-invoice (on demand)  | Invoice document type, intermediary or BYO signing connector, buyer TIN capture, Get Document Printout                                                                                                                                          | Only after a registered merchant with B2B sales commits                                                                                       |

Each phase ships docs and memory/rulings in the same PR set (documentation parity). Production
verification after each deploy follows the verify-against-production rule (health commit, live
checkout on a guest cart; completing a real purchase needs Ahmad's go-ahead).

## 7. Risks

- Treating `taxEnabled` as a billing feature again (TAX-1 rationale was a lapsed plan silently
  stopping VAT). The new gate must key on verification, not plan; free-plan merchants keep working.
- A verified merchant whose certificate expires silently stops collecting. Mitigate with 30/7/1-day
  notices and a grace policy decided by Ahmad (Q6).
- Storing ID/tax documents is sensitive PII: private bucket, signed URLs, access audit, retention
  tied to `docs/RETENTION.md` (tax records retention in Egypt UNVERIFIED), erasure flows must not delete
  records Ebda must retain; DPA copy needs a row for these documents.
- ETA rules change by decision, not by law; build the mandate list as data (per merchant `mode`), not code.
- `piastre`/minor-unit confusion: ETA amounts are decimal EGP; mapper must convert integer minor
  units explicitly and round per ETA's expectations (verify rounding rules on PreProd).

## 8. Open questions for Ahmad

1. **Is Whisky 11 / Ebda crossing the registration threshold soon?** Digital services to Egyptian
   merchants may make registration compulsory; we should confirm with the accountant before launch
   pricing is final, and decide inclusive vs exclusive plan prices (Q4).
2. **E-finance TIN validation**: approve emailing ecommerce_support@efinance.com.eg to ask whether a
   domestic SaaS store builder can onboard (cost, simplified e-commerce registration needed, OTP
   channel)?
3. **ETA sandbox**: who creates the PreProd taxpayer/ERP profile (needs a company TIN)? Can we use a
   friendly merchant's registration for PreProd?
4. Plan pricing when Ebda registers: VAT-inclusive or plus VAT on top of current EGP plan prices?
5. Per-product VAT classes (exempt/zero-rated/other rates) for registered merchants: needed in v1, or
   keep the current single summed rate per store?
6. Expiry policy: re-verify every 12 months with a grace period of N days, or revoke immediately?
7. Is a verified, VAT-collecting merchant allowed to run without ETA receipts (mode `off`) if ETA has
   not named them yet, with the UI showing a "your ETA e-receipt obligation" reminder? (Recommended.)
8. B2B e-invoice: does any current or near-term Ebda merchant sell B2B? If not, P4 stays shelved.
9. Do Egyptian online-store sales count as e-receipt B2C "POS/ERP" sales for the mandate? Our reading
   of the SDK says the receipt is POS/ERP-issued for sales to final consumers; online-channel handling
   (delivery vs collection, courier cash-on-delivery timing for the receipt date) is UNVERIFIED and
   should be confirmed with ETA or an accountant before P3.
10. Ruling TAX-1 was an explicit owner decision (2026-10-01). This design supersedes its "taxEnabled
    alone" clause; confirm that is intended.
11. Competitor check (Zid, YouCan, ExpandCart, Wuilt, Shopify Egypt): is a hands-on sign-up comparison
    worth doing before we market "verified VAT + ETA receipts"?

## 9. Costs

| Item                                                           | Amount                                                                     | Who pays            | Source                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| ETA e-invoice/e-receipt API usage                              | no fee documented                                                          | n/a                 | SDK has no pricing page; absence only, UNVERIFIED                               |
| Digital signature certificate (personal)                       | about EGP 700-1,000 per year                                               | merchant            | [S] https://edariba.com/en/electronic-seal-price-2025-required-documents-egypt/ |
| eSeal (company) certificate                                    | EGP 950-3,600 depending on CA and term (Egypt Trust 1y 950, MCDR 1y 1,800) | merchant (B2B only) | same [S]                                                                        |
| USB crypto-token                                               | EGP 250-800 one-off, 500 re-issue                                          | merchant (B2B only) | same [S]                                                                        |
| E-finance TIN validation service                               | unknown                                                                    | Ebda                | UNVERIFIED (Q2)                                                                 |
| Engineering                                                    | P0 about 1 week; P1 about 0.5-1 week; P2 about 2-3 weeks; P3 about 1 week  | Ebda                | estimate                                                                        |
| Cloud                                                          | one Inngest function family, small R2 volume, negligible                   | Ebda                | estimate                                                                        |
| Accountant/legal review of gating copy and Art. 67/68 exposure | one-off consult                                                            | Ebda                | recommended                                                                     |

E-receipts need no hardware by the SDK as read today (signing disabled, UNVERIFIED for future
enforcement); that is the main reason to ship B2C first.

## 10. Primary sources index

- ETA English translation of VAT Law 67/2016 (to Jan 2023): https://www.eta.gov.eg/sites/default/files/2024-02/Law-english-no.67-2016.pdf.pdf
- ETA eInvoicing/eReceipt SDK home and onboarding: https://sdk.invoicing.eta.gov.eg/ , https://sdk.invoicing.eta.gov.eg/start/
- API list: https://sdk.invoicing.eta.gov.eg/api/ , /einvoicingapi/ , /ereceiptapi/
- Authentication: https://sdk.invoicing.eta.gov.eg/api/01-login-as-taxpayer-system/ , https://sdk.invoicing.eta.gov.eg/ereceiptapi/01-authenticate-pos/
- Submit receipts: https://sdk.invoicing.eta.gov.eg/ereceiptapi/02-submit-receipt/
- Receipt schema v1.2: https://sdk.invoicing.eta.gov.eg/documents/receipt-v1-2/
- Receipt issuance FAQ (QR, 24h, POS registration, submitter=issuer): https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/
- Signing: https://sdk.invoicing.eta.gov.eg/signature-creation/ ; Toolkit: https://sdk.invoicing.eta.gov.eg/toolkit/home/ , https://sdk.invoicing.eta.gov.eg/toolkitapi/05-qrcode/
- Rate limits: https://sdk.invoicing.eta.gov.eg/apigovernance/ ; environments: https://sdk.invoicing.eta.gov.eg/faq/
- E-Commerce Taxes API platform, TIN validation (June 2023): https://www.eta.gov.eg/sites/default/files/2023-06/20230619_e-commerce_tax_api_platform.pdf ; ecomSDK page: https://eta.gov.eg/en/ecomSDK
- Secondary: KPMG, Sovos, vatupdate, Wafeq (see inline links). Re-check every [S] claim against the ETA decision
  text on eta.gov.eg before it drives a rule.

Not fetched or not reachable (UNVERIFIED by construction): ETA decision texts 281/2025 and 361/2025,
the Law 157/2025 text, the VAT Executive Regulations (invoice content, price display), the ETA
"registered" lookup page (403), competitor help centers other than Salla.

## 11. Addendum 2026-10-26: P2-P4 build (ETA e-receipt connector)

Status: BUILT behind a flag, branch `feat/eta-ereceipt`, migration `20261105000400_eta_ereceipt`. Ruling ETA-1 (docs/RULINGS.md).
Scope rule (Ruling VAT-0): Ebda itself charges no VAT; this is the connector for MERCHANTS who are verified VAT payers (section 5.2 gate).
Every API fact below was read from the official SDK on 2026-10-26; **UNVERIFIED** marks what only a PreProd run can settle.

### 11.1 What was built

| Piece                                                                                                                                       | Where                                                                     | Source                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Per-store flag `eta_ereceipt` (hidden, super-admin toggle, in no plan baseline = OFF)                                                       | `packages/shared/src/features.ts`                                         | plan 5.7                                                                                    |
| Tables `eta_connections` (credentials AES-256-GCM JSON blob), `eta_receipts` (state, document, uuid chain)                                  | `schema.prisma`, migration, RLS                                           | plan 5.1                                                                                    |
| Receipt v1.2 and Return Receipt v1.2 mapper (integer-exact, refuses on total mismatch)                                                      | `apps/api/src/lib/eta/receipt-mapper.ts`                                  | https://sdk.invoicing.eta.gov.eg/documents/receipt-v1-2/ , .../return-receipt-v1-2/         |
| Document serialization + uuid (SHA-256 of the uppercase-name serialization with empty uuid)                                                 | `lib/eta/serialize.ts`                                                    | https://sdk.invoicing.eta.gov.eg/document-serialization-approach/ , .../receiptissuancefaq/ |
| API client: token (`/connect/token`, POS headers), `POST /api/v1/receiptsubmissions`, `GET /api/v1/receiptsubmissions/{id}/details`         | `lib/eta/client.ts`                                                       | .../ereceiptapi/01-authenticate-pos/ , 02-submit-receipt/ , 06-get-receipt-submission/      |
| State machine (retry 30 s doubling to 30 min, 429 `Retry-After`, 503 2 s, 422 duplicate wait, 24 h deadline -> `late`)                      | `lib/eta/receipt-state.ts`                                                | .../apigovernance/                                                                          |
| Service + 3 jobs (enqueue on `order/created` and `order/refunded`; submit one attempt per run, serialized per store; durable redrive timer) | `services/eta-receipt.service.ts`, `lib/inngest/functions/eta-receipt.ts` | plan 5.7                                                                                    |
| Admin: Tax > ETA e-receipts connect form (ar/en), order page status + QR + "issue again"                                                    | `apps/admin/.../tax/eta`, order detail                                    | plan 5.3                                                                                    |
| API: `GET/PUT /stores/:id/eta/connection`, `POST .../check`, `GET /stores/:id/orders/:orderId/eta`, `POST .../eta/receipts/:id/retry`       | `routes/eta.routes.ts`                                                    |                                                                                             |
| Help (ar+en) and the stale "not yet integrated" lines                                                                                       | `apps/help/content/*/eta-e-receipts.mdx`, `vat-registration.mdx`          |                                                                                             |

### 11.2 Decisions and facts the design rests on

1. **Per-merchant credentials, one connection per store.** The SDK says the submitter must be the issuer and the e-receipt auth page documents only the merchant's own POS credentials (plan 2.3). The merchant pastes client id, client secret, POS serial and (when their profile has one) the pre-shared key. Never logged; masked on read (`****` + last 4 reuses `isMaskedSecret`, so a masked value saved back keeps the stored secret).
2. **A 202 is not acceptance.** The submit API answers 202 "because validation is not complete"; the verdict (`Valid` / `Invalid`, `longId`, per-receipt `errorCode`) is read from the submission details endpoint. Rows therefore go `submitted -> accepted | rejected`, and the QR (which only resolves after acceptance) is shown only for `accepted`.
3. **Item codes are the merchant's.** Receipt lines need a GS1/EGS `itemCode`; an EGS code is `EG-<TaxpayerID>-<InternalCode>` and must be registered and approved by the ETA before use (https://sdk.invoicing.eta.gov.eg/api/09-create-egs-code-usage/). The connection stores one `defaultItemCode` (the merchant registers it in the ETA portal); each line keeps its own `internalCode` (SKU or product id). Per-product codes through the Create EGS Code Usage API are a follow-up (needs the merchant's intermediary grant).
4. **Totals must equal what the customer paid.** The mapper allocates by largest remainder over goods (after discount), shipping, COD fee and extra amount (VAT base = `orders.taxable_amount`, Ruling MONEYB-2), and throws `ETA_TOTAL_MISMATCH` rather than send a receipt that disagrees with the charge; the row becomes `failed` with that code (never a silent bad document).
5. **Only orders sold under a verified VAT registration** (`orders.seller_tax_registration_number` set, Ruling TAX-2) are queued; the seller block's RIN and trade name come from that frozen snapshot, never from the editable form.
6. **Document stability.** The document is built once and stored; every retry re-sends the same bytes (same uuid). A refused receipt is re-issued as `seq + 1` with a new uuid and `referenceOldUUID` = the refused one (https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/).
7. **previousUUID chain**: the latest receipt of the same store+environment that carries a uuid and was not `failed`/`rejected`; builds are serialized by the job's concurrency key (limit 1 per store). UNVERIFIED how ETA treats a rejected predecessor.
8. **Returns are built from the sale's own lines.** `order/refunded` already carries `partial {items:[{orderItemId, quantity}], refundKey (the Return id), refundAmount}`; the connector stores the sale's line map (`eta_receipts.line_map`, goods lines aligned with `itemData`) and builds each Return Receipt v1.2 (`receiptType "r"`, `referenceUUID`, `salesIssuedDateTime`) by scaling the receipted sale lines for the units returned. Values are cumulative per line (value(cum) - value(cumBefore) in piastres) so several partial returns add up to exactly the sale line; units already returned on earlier non-refused return receipts are excluded, over-returns are refused (`ETA_RETURN_EXCEEDS`), and a receipt whose total differs from the Store's `refundAmount` by more than a piastre per line is refused (`ETA_RETURN_TOTAL_MISMATCH`, row `failed`, nothing sent). A whole-order refund returns every unit not yet returned plus the fee lines (shipping, COD fee) once. Idempotent per `refundKey`; re-issuing a refused return keeps its `refundKey`. Return receipts are valid up to 540 days after the sale (FAQ). A **price-only refund** (`amountOnly`: money returned from the provider dashboard or a partial-amount refund, no goods lines) becomes a **Return Receipt Without Reference** (`receiptType "RWR"`, https://sdk.invoicing.eta.gov.eg/documents/return-receipt-without-reference-v1-2/): one synthetic "Price adjustment refund" line for the refunded amount, split into net and VAT at the sale's own rate, `salesIssuedDateTime` = the sale receipt's time, no `referenceUUID`. `header.documentUseReason` is mandatory and only accepts the two codes on https://sdk.invoicing.eta.gov.eg/codes/return-with-no-reference-reasons-type/ : **I** "International return receipt" and **B** "Sales issued before adoption" (`ETA_RETURN_NO_REF_REASONS` in `@ebda/shared`; the page gives no Arabic, the Arabic labels are ours). Because the reason is a legal statement only the merchant can make, the row waits as `manual` / `reason_required` and the **order page shows a required picker only on those rows** (so only for stores with ETA connected); choosing a reason (`POST /stores/:id/eta/receipts/:id/return-reason`) claims the row and queues it. Refunds across non-refused return receipts can never exceed the sale receipt total (`ETA_RETURN_EXCEEDS`). CAVEAT for the PreProd run and the accountant: both documented reasons describe sales the ETA cannot reference (pre-adoption or issued outside Egypt), which is not literally a price adjustment on a sale we receipted; the ETA may refuse an RWR that points at a sale it knows, in which case the correct instrument is a credit through the merchant's accountant. Settle in 11.5.
9. **Cloudflare path (#229/#230).** Only portable ORM calls (create / findFirst / findMany / updateMany with plain where, unique on `(store_id, order_id, kind, seq)`), no raw SQL, no interactive transaction, no cross-store scan (the retry timer is a durable job, not a polling cron). Both tables are store-scoped (StoreDO); `packages/cf-schema` now carries both (`model-split.json`: EtaConnection and EtaReceipt -> store-do; schema regenerated, 151 models, 122 store tables). The erasure classification (credentials deleted on store close, receipts retained as fiscal records with the order) belongs in the erasure registry that PR #229 introduces; whoever merges second re-runs `node packages/cf-schema/scripts/generate.mjs`.

### 11.3 Signing: what is possible

- **E-receipts**: the submit API takes `signatures[] {signatureType: I|S, value: Base64 CAdES-BES}`, requires the Issuer signature in principle, but states validation "is not deployed" and the Integration Toolkit says signing is disabled for receipts (.../ereceiptapi/02-submit-receipt/, .../toolkit/home/). So receipts ship **unsigned** (`NoopSigner`) and the seam exists: when the merchant sets a signing-bridge URL, `BridgeSigner` posts `{uuid, serialized, sha256, format:"CAdES-BES"}` to it (SSRF-guarded `safeFetch`, optional bearer token stored encrypted) and attaches the returned Base64 as the `I` signature. UNVERIFIED: whether the ETA will start enforcing it, and what exactly it validates.
- **B2B e-invoices**: the document hash (SHA-256 of the canonical serialization, UTF-8) must be signed with CAdES-BES using the taxpayer's **eSeal X.509 certificate**, whose private key lives on a USB token/HSM (https://sdk.invoicing.eta.gov.eg/signature-creation/). A Worker cannot hold or reach that key, and Ebda must not hold merchants' eSeal keys. The only supported shape is the **merchant-side signing bridge**: a small service the merchant runs next to their token (or a remote-signing service they authorise) exposing the contract above. For e-invoices the signature is embedded into the document JSON in a new element, not sent as a separate array (signature-creation page); the page does not give that element's name or the `signatureType` shape, so it is read from the Postman collection at P4 start. The ETA-accepted alternative (a Certificate Authority's cloud/remote seal) is **UNVERIFIED**: no ETA page we read mentions remote or HSM-as-a-service signing.
- **Unblock for P4**: one registered merchant with B2B sales and an eSeal, an Ebda signing-bridge reference implementation (a ~100-line Node service using their token's PKCS#11 driver), and PreProd credentials. Until then there is no B2B submission code; the e-invoice login (intermediary `onbehalfof`, plan 2.3) and the Invoice v1.0 mapper start from the pieces above (serializer, client, state machine, bridge contract are document-type agnostic).

### 11.4 Rollout (P3)

1. Merge with the flag off everywhere (no store has the key, no row is ever written; the three jobs exit after one cached flag read).
2. PreProd: a super-admin switches `eta_ereceipt` on for an Ebda test store; connect with a PreProd profile; run the P2 exit checks: 100 receipts accepted incl. return receipts; 429/503 chaos (unit-covered, to be run live); QR resolves on https://preprod.invoicing.eta.gov.eg. This also settles the UNVERIFIED list: token request content type, the empty-uuid serialization, buyer block for unidentified consumers, the previousUUID rule, and the unit price/quantity rounding tolerance.
3. Production pilot with 1-2 registered merchants who the ETA already obliges, `environment = prod`; watch `eta.receipt.late` / `rejected` alerts; exit when zero `late` over 2 weeks.
4. Docs: help article live from step 1 (it states the feature is enabled by support).

### 11.5 UNVERIFIED list (settle on PreProd before the pilot)

- Whether the ETA accepts a Return Receipt Without Reference (reason I or B) for a price adjustment on a sale it already holds (see 11.2 item 8 caveat).
- `/connect/token` content type (page silent; form-urlencoded used).
- Serialization of an empty string value (`"UUID"""`) and numeric text (`String(n)`), against the Postman collection.
- Whether an unidentified person buyer (`type P`, no id) is accepted below the 150,000 EGP threshold with only name/mobile.
- Maximum batch size (we submit 1 receipt per call).
- `unitPrice * quantity = totalSale` tolerance (we round the unit price to 5 decimals).
- Behaviour of `previousUUID` after a rejected receipt.
- Whether the ETA ever accepts an intermediary token for receipts (would remove copy-pasted secrets).
