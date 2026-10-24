# Egypt Shipping Carriers: Research Brief for Ebda

Researched: 2026-10-03

**Method note.** Most carrier doc portals (docs.bosta.co, docs.shipblu.com, bosta.com pricing) were blocked by the research sandbox's egress proxy, and several carriers publish no public docs at all. Facts come from search snippets, official SDK repos on GitHub, and open-source integrations. "(search)" marks facts seen only in a search snippet. As-of date is 2026-10-03 unless a page shows its own date. Anything not confirmed is **unverified**. No price has been invented; carrier rate cards are mostly contract-specific.

**Update 2026-10-24 (ruling PROVIDERS-3).** The Bosta, ShipBlu, Mylerz and Aramex integrations were re-checked against each carrier's current official docs (OpenAPI/Swagger/WSDL, how-to pages, Aramex's Shipping Services manual read in a browser). Several "unverified" items above are now settled (Aramex: test host, COD service code `CODS`, EGP is a valid currency code, units, report id; Bosta: 23-state table, webhook payload); the per-item results are in `2026-10-24-provider-docs-reverify.md` (Carriers section). Later the same day: Aramex duplicate bookings are guarded by `ForeignHAWB` (manual Table 18 / ERR30), the official Tracking WSDL and PHP sample match the adapter, and no file we hold lists the tracking update codes or any domestic product type. The Aramex "COD amount in USD only" source above is a third-party claim: Aramex's own manual lists EGP as a currency code, but domestic-EGP COD enablement per account is still unconfirmed.

## Answer

Start with **Bosta** (public REST API, API-key auth, staging environment, COD, AWB printing, webhooks, the dominant Egyptian e-commerce carrier) and **Aramex** (SOAP/JSON Shipping Services API with rate calculator, label and tracking, but COD amount is USD-only per one source). After those, add **J&T Express Egypt** next: its JMS open platform has a documented create/cancel/print/trace flow and has been integrated by other Egyptian platforms. Then **Mylerz** (token-auth REST, COD and "CC on delivery" payment types, requires warehouse + neighborhood fields), then **ShipBlu** (public Swagger docs and a sandbox on request). R2S, Sprint, Turbo and Egypt Post have no public self-serve API that we could verify; treat them as manual/aggregator-only until a merchant asks. The common `ShippingCarrier` interface must treat quoting as optional (many carriers have no public rate API), identify shipments by more than one id (J&T cancels by transaction id, not waybill), accept COD amounts in piastres while some carriers want USD or decimals, and model webhooks that may have no signature (Bosta) so the callback URL must carry a secret.

## Decision table

| Carrier           | API + docs                                             | Sandbox                                | Auth                                | COD                                  | Label              | Tracking webhook                     | Public pricing        | Evidence quality                    |
| ----------------- | ------------------------------------------------------ | -------------------------------------- | ----------------------------------- | ------------------------------------ | ------------------ | ------------------------------------ | --------------------- | ----------------------------------- |
| Bosta             | REST v2, https://docs.bosta.co                         | Yes: `stg-app.bosta.co`                | API key                             | Yes                                  | AWB print endpoint | Yes, `webhookUrl` on create; no HMAC | Partial, see detail   | Medium (SDK + snippets)             |
| Aramex            | Shipping Services, Rate Calculator, Tracking APIs      | Yes (test account, **unverified** how) | Account credentials in request body | Yes, amount in USD only (one source) | Yes (PrintLabel)   | No webhook found; poll Tracking      | No (account-specific) | Medium (official manual PDF listed) |
| J&T Express Egypt | JMS open platform https://open.jtjms-eg.com            | **unverified**                         | apiAccount + timestamp + MD5 digest | Yes (COD paid scan status)           | Yes (base64 PDF)   | Yes (form push, digest-verified)     | No                    | Medium (third-party code)           |
| Mylerz            | REST https://integration.mylerz.net                    | **unverified**                         | Bearer token via `/token`           | Yes: `COD`, `CC`, `PP`               | **unverified**     | **unverified**                       | No                    | Low-medium                          |
| ShipBlu           | REST + Swagger https://docs.shipblu.com                | Yes, on request (tech@shipblu.com)     | API key                             | **unverified** (likely)              | **unverified**     | **unverified**                       | No                    | Low (docs blocked)                  |
| R2S               | Via ClickPost; direct docs **unverified**              | **unverified**                         | **unverified**                      | **unverified**                       | **unverified**     | **unverified**                       | No                    | Low                                 |
| Sprint            | No public API found                                    | n/a                                    | n/a                                 | n/a                                  | n/a                | n/a                                  | No                    | Low                                 |
| Turbo             | Nothing found                                          | n/a                                    | n/a                                 | n/a                                  | n/a                | n/a                                  | No                    | None                                |
| Egypt Post        | No public merchant API found; tracking via aggregators | n/a                                    | n/a                                 | n/a                                  | n/a                | via third-party trackers only        | No                    | Low                                 |

## Carrier detail

### Bosta

- **Docs:** https://docs.bosta.co (base `https://app.bosta.co/api/v2/`, search snippet); SDKs https://github.com/bostaapp/bosta-nodejs and https://github.com/bostaapp/bosta-ruby; Postman-style mirror https://3mwf7w72fh.apidog.io/welcome-1726329m0.
- **Sandbox:** staging at `https://stg-app.bosta.co` / `https://stg-business.bosta.co` (bosta-nodejs README). Registration: https://business.bosta.co/signup; API key comes from the business dashboard.
- **Endpoints (SDK):** create / update / list / get-by-tracking delivery, track, print AWB, terminate delivery; pickups CRUD; reference data for cities, zones, delivery states and types.
- **Coverage:** governorate list **unverified**; city and zone endpoints exist, so address mapping is via Bosta's city/zone ids (Ebda needs a governorate-to-Bosta-city map).
- **COD:** `cod` field on create delivery; API can auto-calc COD from order (search snippet, 2026-10-03).
- **COD settlement and fees:** reported 24-48h settlement and fee components (insurance 0.5%, 5-20 EGP; collection 1% above 2,000; open-package fee 7 EGP; VAT 14%), plus online payment 2.35% + 1 EGP via Paymob, from a third-party business-model blog (https://businessmodelcanvastemplate.com/blogs/how-it-works/bosta-how-it-works, via search). **Unverified** against Bosta; official page https://www.bosta.com/delivery-costs-and-transit-times was blocked.
- **Label:** AWB print endpoint (SDK).
- **Webhooks:** set `webhookUrl` per delivery; POST on state change. Bosta sends **no HMAC or secret**; put a secret token in the URL and validate it (GitHub/community note, search snippet). Webhook doc: Bosta's webhook guide on docs.bosta.co (**unverified** exact path).
- **Returns / cancel:** terminate delivery endpoint exists; return-to-origin and "customer return" delivery type: **unverified** details.
- **Pricing per shipment:** weight/dimension/zone based (search); public per-zone numbers could not be read. **Unverified**. Bosta has a pricing/delivery-cost page; a rate-quote API endpoint is **unverified**.
- **Extra:** valU-Bosta installment-on-delivery partnership (https://www.arabfinance.com/en/News/newdetails/11201, search).

### Aramex Egypt

- **Docs:** https://www.aramex.com/us/en/developers-solution-center/aramex-apis ; Shipping Services manual https://www.aramex.com/docs/default-source/resourses/resourcesdata/shipping-services-api-manual.pdf ; Shipment Preparation manual https://www.aramex.com/content/uploads/109/232/42024/shipments-preparation-api-manual.pdf (not read in full).
- **APIs:** Shipping Services (create shipments, print labels, pickups, attachments), Rate Calculator, Shipment Tracking, Location Services (search summary of the developer center, 2026-10-03). Open-source SDK reference: https://github.com/Bilinx-solutions/Laravel-Aramex-SDK.
- **Sandbox/keys:** test environment exists per Aramex developer docs; how to obtain an account number + PIN for Egypt: **unverified**. Production requires an Aramex customer account (sales contact).
- **COD:** `CashOnDeliveryAmount` with currency; one integrator source says amount may only be given in USD (https://support.shiptheory.com/support/solutions/articles/24000049808-how-to-send-a-cash-on-delivery-shipment-with-aramex). **Unverified** for domestic Egypt; confirm whether EGP is accepted domestically. This is the key adapter risk.
- **Remittance:** reported 3-7 days in Egypt, Aramex 5-7 days, and COD fee USD 1.00-1.80 per shipment (https://easysellapp.com/blogs/wiki/egypt-ecommerce-cod-market-entry-shopify-2026, third-party marketing blog, **unverified**).
- **Webhooks:** none found; plan to poll tracking. **Unverified**.
- **Pricing:** account-specific via Rate Calculator API; no public rate card.

### J&T Express Egypt

- **Docs:** https://open.jtjms-eg.com/#/apiDoc/index (per https://github.com/mohammedam33n/jt-express-laravel; not read directly). API host `https://openapi.jtjms-eg.com/webopenplatformapi/api`.
- **Endpoints (from open-source adapter, https://github.com/NUMU-IO/NUMU-api/pull/605):** `order/addOrder`, `order/cancelOrder` (by transaction id, not waybill), `order/printOrder` (base64 PDF), `logistics/trace`, `location/getLocation`.
- **Auth:** form-posted `bizContent`; headers `apiAccount`, `timestamp`, `digest = base64(md5(bizContent + privateKey))`; order ops add a business digest involving customerCode, password hash and a fixed salt (see PR for the exact formula; do not copy a salt into our docs without reading the official doc).
- **Webhooks:** form pushes verified with the same digest against the merchant's private key; status mapped from scan type codes (ship, deliver, COD paid, return, failure, cancel).
- **Gotchas:** addresses must match J&T's Arabic location tree or the create fails (422 in that adapter); API-created shipments can show as "Printed" in JMS without calling `printOrder` (https://github.com/ahmed5330/kunonline/issues/25, search).
- **Coverage:** "1,000+ branches and 10,000 delivery points" (https://www.weship.com/en/carriers/j-t-express-eg, search, marketing claim). Governorates: **unverified**.
- **COD fee/settlement/pricing/sandbox:** **unverified**.

### Mylerz

- **Docs:** API v1.3.1 PDF mirror https://www.slideshare.net/slideshow/mylerz-api-v131-1pdf/259928573 (13 methods: add orders, statuses, details, tracking; search); integration host `https://integration.mylerz.net` for Egypt (https://github.com/mohamedhekal/shipbridge-mylerz/blob/main/docs/GUIDE_AR.md). WordPress plugin https://wordpress.org/plugins/mylerz/.
- **Auth:** `POST /token` with username, password, `grant_type=password`; Bearer token afterwards.
- **COD:** `Payment_Type` of `PP` (prepaid), `COD`, or `CC` (credit-card-on-delivery) with `COD_Value`. Required fields: customer mobile, neighborhood, and a pre-registered warehouse name (search/GitHub).
- **Sandbox, label, webhooks, cancel, pricing, settlement:** **unverified**.

### ShipBlu

- **Docs:** https://docs.shipblu.com (Quick Start, Tutorial, API Reference, JS client; source https://github.com/ShipBlu/shipblu.github.io). Swagger at https://api.staging.shipblu.com/docs/.
- **Sandbox:** request by emailing tech@shipblu.com with business account name (docs landing, search snippet). **API key** generated from the merchant account.
- COD, labels, webhooks, pricing, governorates, returns: docs blocked; **unverified**.

### R2S, Sprint, Turbo, Egypt Post

- **R2S:** third-party integrations exist (ClickPost https://www.clickpost.ai/carrier-integration/r2s, Odoo https://apps.odoo.com/apps/modules/13.0/r2s_delivery), implying an API with tracking and NDR; direct docs, auth and sandbox **unverified**.
- **Sprint:** https://sprint.xyz/ advertises e-commerce platform integrations and tracking SMS; no public API doc found. **Unverified.**
- **Turbo:** nothing usable found. **Unverified.**
- **Egypt Post:** only tracking via aggregators (TrackingMore, Track123); merchant booking API: none found. COD refusal 12-18% and return-to-origin 15-30% are market figures from https://www.udjatagency.com/ecommerce-in-egypt/ (search, undated marketing blog, **unverified**).

### Aggregators (alternative route)

- ClickPost lists Egyptian carriers (J&T, R2S) with order creation, labels, tracking, NDR (https://www.clickpost.ai/carrier-integration/jtexpress). Not evaluated for cost; likely overkill for Ebda but a way to cover R2S quickly. **Unverified.**

## What the common `ShippingCarrier` interface must accommodate

1. **Quote is optional.** Bosta and Aramex may offer rate endpoints; others are contract rates. Interface: `quote()` returns `{amount_piastres, source: 'api'|'merchant_table'}`, with a merchant-configured flat/zone rate table as fallback.
2. **Multiple ids per shipment:** carrier shipment id, waybill/tracking number, merchant reference (Ebda order id), and carrier "transaction id" (J&T cancels by it). Store all.
3. **Address model:** carriers want their own city/zone/neighborhood ids (Bosta zones, Mylerz neighborhood, J&T Arabic location tree). Keep a per-carrier location map and a "needs mapping" failure state rather than guessing.
4. **COD in piastres internally;** convert at the edge (Aramex possibly USD, others decimal EGP). Also record COD fee, delivery fee and net remittance separately.
5. **createShipment returns label or a label fetch step:** Bosta AWB endpoint, J&T `printOrder` base64 PDF, Aramex PrintLabel. Cache the PDF in object storage.
6. **Cancel semantics differ:** Bosta "terminate", J&T by transaction id; allow `cancel()` to return `not_cancellable` once picked up.
7. **Tracking:** webhooks where available, polling worker where not (Aramex). Normalize to a small status enum (created, picked_up, in_transit, out_for_delivery, delivered, failed_attempt, returning, returned, cancelled, cod_collected, cod_remitted). Webhook auth varies: none (Bosta, so use a secret URL token), digest (J&T). Always verify then dedupe by (carrier, tracking no, status, timestamp).
8. **COD reconciliation:** settlement cadence differs (Bosta reportedly 24-48h, Aramex 3-7 days, unverified). Model `cod_collected_at` (from tracking) separately from `cod_remitted_at` (from carrier statement/CSV/API). Offer a manual "mark remitted" and CSV import, because remittance APIs were not found for any carrier.
9. **Returns:** support a return shipment (reverse) object and RTO status; refusal rates are high so RTO is a first-class state.
10. **Credentials:** BYO per merchant (each merchant has their own carrier contract); encrypt per tenant. Ebda-negotiated master accounts are a later option.
11. **Rate limits / retries:** unknown; queue createShipment with idempotency by merchant reference since no idempotency header was found.

## Recommendation

Adapter order: **Bosta -> Aramex -> J&T Express -> Mylerz -> ShipBlu -> R2S (via direct docs or ClickPost) -> Sprint/Turbo/Egypt Post only on merchant demand, plus a "manual carrier" adapter (merchant enters tracking number) shipped on day one.** Rationale: Bosta and J&T have the best-evidenced documented flows; Mylerz and ShipBlu have public docs but thinner evidence; the rest have no verified public API. Aramex stays second because of merchant demand but needs a COD-currency test early.

## Open questions for Ahmad

1. Do we hold master accounts or does each merchant bring carrier credentials? (Affects negotiating rates and COD reconciliation.)
2. Can Whisky 11 open a test Bosta, Aramex, J&T and ShipBlu account now so we can read the real docs behind logins?
3. Is a manual-carrier adapter acceptable for launch for carriers without APIs?
4. Do we want Ebda to show live shipping quotes at checkout, or merchant-defined flat/zone rates in v1?
5. Is Aramex domestic COD in EGP supported? Ask Aramex sales in writing.
6. Should COD refusal/RTO analytics be in v1?

## Sources

All accessed 2026-10-03. "(search)" = search snippet only because the page was blocked.

- Bosta: https://docs.bosta.co (search), https://github.com/bostaapp/bosta-nodejs , https://github.com/bostaapp/bosta-ruby , https://3mwf7w72fh.apidog.io/welcome-1726329m0 (search), https://www.bosta.com/delivery-costs-and-transit-times (search), https://businessmodelcanvastemplate.com/blogs/how-it-works/bosta-how-it-works (search, third-party), https://www.arabfinance.com/en/News/newdetails/11201 (search)
- Aramex: https://www.aramex.com/us/en/developers-solution-center/aramex-apis , https://www.aramex.com/docs/default-source/resourses/resourcesdata/shipping-services-api-manual.pdf (search), https://www.aramex.com/content/uploads/109/232/42024/shipments-preparation-api-manual.pdf (search), https://support.shiptheory.com/support/solutions/articles/24000049808-how-to-send-a-cash-on-delivery-shipment-with-aramex (search), https://easysellapp.com/blogs/wiki/egypt-ecommerce-cod-market-entry-shopify-2026 (search, third-party), https://github.com/Bilinx-solutions/Laravel-Aramex-SDK (search)
- J&T Egypt: https://github.com/NUMU-IO/NUMU-api/pull/605 , https://github.com/mohammedam33n/jt-express-laravel (search), https://github.com/ahmed5330/kunonline/issues/25 (search), https://www.weship.com/en/carriers/j-t-express-eg (search), https://www.clickpost.ai/carrier-integration/jtexpress (search)
- Mylerz: https://github.com/mohamedhekal/shipbridge-mylerz/blob/main/docs/GUIDE_AR.md , https://www.slideshare.net/slideshow/mylerz-api-v131-1pdf/259928573 (search), https://wordpress.org/plugins/mylerz/ (search)
- ShipBlu: https://docs.shipblu.com (search), https://github.com/ShipBlu/shipblu.github.io (search)
- R2S / Sprint / Egypt Post: https://www.clickpost.ai/carrier-integration/r2s (search), https://apps.odoo.com/apps/modules/13.0/r2s_delivery (search), https://sprint.xyz/ (search), https://www.trackingmore.com/egypt-post-tracking-api (search), https://www.udjatagency.com/ecommerce-in-egypt/ (search)
