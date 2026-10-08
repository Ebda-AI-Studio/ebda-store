# Egypt payments and shipping: connect-any-provider integrations

Status: RESEARCH + PLAN ONLY (no implementation). Date: 2026-10-07. Owner: Ahmad.

Follow-ups (2026-10-08, branch `fix/provider-followups`): Kashier webhooks are confirmed server-to-server
before they change money state (Ruling PROVIDERS-17); merchants request courier pickups for Bosta, Aramex
and Mylerz from the order's shipment card (PROVIDERS-18, residuals PROVIDERS-19).
Base: `origin/main` @ `7463d841`. Branch `docs/egypt-providers`.

Goal: a merchant connects any payment gateway or carrier by ONLY entering that provider's credentials
in store settings. Each merchant uses their OWN provider account; Ebda never holds merchant money.

Source legend: **[V]** = confirmed on an official page / official host fetched 2026-10-07.
**UNVERIFIED** = third-party page, GitHub integration, search snippet, or not seen at all.
Anything UNVERIFIED must be settled (official doc or sandbox call) before it drives code.
Earlier briefs: `docs/ebda/research/egypt-payment-providers.md`, `egypt-shipping-carriers.md` (2026-10-03,
doc portals were blocked then); this plan supersedes them where it marks something [V].

## 1. Executive summary

- **Payments with public docs:** Paymob, Kashier, FawryPay, Geidea, OPay Egypt (PaySky partly). Already in
  code: Paymob, Kashier, Fawry (all built against local stubs). Next real wins are **Geidea** and **OPay**,
  then **PaySky**. valU, Sympl, Souhoola, Aman, Meeza, Apple Pay and wallets are reached THROUGH those
  gateways, not as separate adapters. InstaPay has no merchant API (only Kashier exposes it, see 2.12).
- **Shipping with public docs:** Bosta (best), ShipBlu (public OpenAPI), Mylerz (public Swagger, creds by
  sales), DHL Express (MyDHL, needs DHL account), FedEx and UPS (OAuth REST, international). Aramex has
  public WSDLs but the portal blocks bots. J&T, R2S, Turbo, Sprint, Egypt Post: partner-gated or no API.
- **There is no multi-carrier aggregator with a public Egyptian API.** Per-carrier adapters are the only route.
- **No Egyptian carrier exposes a COD remittance/settlement API.** Reconciliation stays "delivered + cod
  amount" plus the existing CSV statement import.
- **Recommended batch 1 (payments):** harden Paymob + Kashier + Fawry against official sandboxes (they exist
  but are unverified). **Batch 1 (shipping):** Bosta hardening + ShipBlu + Mylerz. Section 7.
- **Design:** one declarative provider catalog drives the settings form, secret handling, "Test connection",
  webhook URL and capability flags for BOTH payments and carriers, replacing the per-provider cards.

## 2. Payments

### 2.0 What Ebda has today

`apps/api/src/services/payment-providers/`:

- `PaymentProviderV2` (`types.ts`): `capabilities` (methods, instruction kinds, currencies, partialRefunds,
  refunds, webhooks, remoteStatus, savedCards) plus `createPayment`, `verifyWebhook(rawBody, headers,
creds)`, `getStatus`, `refund`, `partialRefund`. Amounts are integer piastres at every boundary;
  create/refund carry an `idempotencyKey`; `PaymentInstruction` is a tagged union (redirect, iframe,
  reference-code, manual-instructions). Errors are `PaymentProviderError` codes (timeout/unavailable count
  against the circuit breaker; rejected/invalid do not).
- `ProviderCredentials` = `{apiKey, secretKey, merchantId, webhookSecret, mode, settings}`; stored in
  `PaymentConfig` (`schema.prisma`) as AES-256-GCM columns (`apiKey`, `secretKey`, `merchantId`,
  `webhookSecret`), with `apiKeyLast4` / `merchantIdLast4` fingerprints; non-secret `settings` JSON;
  `testMode`, `supportedMethods`, `fixedFee`, `percentageFee`, `healthStatus`. Admin routes return
  `maskCredentials` (`****` + last 4); `describeForLog` is the only loggable view.
- `registry.ts` registers cod, instapay, paymob, kashier, fawry. `PaymentProvider` is a closed union
  `'cod'|'instapay'|'paymob'|'kashier'|'fawry'` and the DB enum `PaymentProvider` mirrors it, so a new
  gateway currently needs a migration, a type edit, and a bespoke admin card (`ProviderCard.tsx`).
- Webhooks: `POST /webhooks/payment/:provider` (raw body). `webhook-signature.ts` extracts the signature
  per gateway (Paymob `?hmac=`, Kashier `x-kashier-signature`, Fawry body `messageSignature`) and the
  store is resolved via `ebda_webhook_resolve_store` from references in the unverified body; verification
  runs afterwards over the raw body with the merchant's secret; inbox dedupes on `eventId`.
- Admin: `payment-settings.routes.ts` (CRUD per provider, `POST /payment-settings/:provider/test`),
  `apps/admin/.../payment-settings` page + `ProviderCard`.
- Every field marked `UNVERIFIED:` inside the Paymob/Kashier/Fawry adapters is still open (the files say so).

### 2.1 Provider matrix

Hosts/paths shown are from official pages unless marked UNVERIFIED. "Creds" = what the merchant copies.

| Provider                                | Docs                                                                   | Auth model / creds                                                                                                                                                                                                                                           | Checkout                                                                                                                           | Webhook verification                                                                                                                                                                                       | Refunds                                                                                                        | Sandbox                                                                                                           | Public?                                                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paymob (Accept)                         | https://developers.paymob.com/paymob-docs/getting-started/overview [V] | Intention API: `Authorization: Token <secret_key>`; merchant copies Secret Key, Public Key, API Key, per-method Integration IDs, HMAC secret (dashboard Settings > API Keys / Payment Integrations; HMAC location UNVERIFIED, third-party says Account Info) | Unified Checkout redirect, Pixel (embedded) [V]                                                                                    | HMAC-SHA512 hex in `?hmac=` query, 20 fields concatenated in lexicographic order [V]                                                                                                                       | Full + multiple partial; kiosk not refundable [V]; refund path `/api/acceptance/void_refund/refund` UNVERIFIED | Test mode toggle, same host `accept.paymob.com`, keys decide mode [V]; 30-day sandbox expiry UNVERIFIED           | Yes                                                                                                                                                                                                             |
| FawryPay                                | https://developer.fawrystaging.com/ [V]                                | `merchantCode` + `secureKey` (given at account creation); no API-key header                                                                                                                                                                                  | JS button (popup/inside/side/redirect), hosted Express link, server-to-server (PayAtFawry reference code, card, MWALLET, valU) [V] | Callback v2: SHA-256 (plain hash, secret appended) in body `messageSignature` over `fawryRefNumber+merchantRefNum+paymentAmount+orderAmount+orderStatus+paymentMethod+paymentRefrenceNumber+secureKey` [V] | Yes, partial (amount-based) [V]                                                                                | Self-register `atfawry.fawrystaging.com/merchant/register` [V]; production URL UNVERIFIED                         | Yes                                                                                                                                                                                                             |
| Kashier                                 | https://developers.kashier.io/ [V]                                     | MID + Payment API Key (header `api-key`, also the HMAC key) + Secret Key (`Authorization: <secret>`, no Bearer); dashboard `merchant.kashier.io/en/dashboard/integration` [V]                                                                                | Payment session -> hosted `sessionUrl` or embedded iframe; direct `/v3/orders` (InstaPay) [V]                                      | HMAC-SHA256 in header `x-kashier-signature` over `signatureKeys` sorted alphabetically as `k=v&k=v` [V]                                                                                                    | `PUT /v3/orders/:id` REFUND, partial by amount; VOID same endpoint [V]                                         | Self-serve test keys, `test-api.kashier.io` / `test-fep.kashier.io` [V]                                           | Yes (best docs)                                                                                                                                                                                                 |
| Geidea (EG)                             | https://docs.geidea.net/docs/geidea-checkout-v2 [V]                    | HTTP Basic: Public Key : API Password (portal location UNVERIFIED)                                                                                                                                                                                           | Server creates session, then JS Popup / Drop-in iframe / Redirect                                                                  | HMAC-SHA256 Base64 (key = API password) over `PublicKey+OrderAmount+OrderCurrency+OrderId+Status+MerchantReferenceId+timestamp` [V]; transport (body vs header) not stated, UNVERIFIED                     | `POST /pgw/api/v2/direct/refund`, multiple partials [V]                                                        | Docs mention sandbox; how a merchant gets it UNVERIFIED                                                           | Docs yes, onboarding gated                                                                                                                                                                                      |
| OPay (EG)                               | https://doc.opaycheckout.com/ [V]                                      | Bearer PublicKey + `MerchantId` header on create; HMAC-SHA512 with Private Key on other calls                                                                                                                                                                | Hosted `cashierUrl` redirect                                                                                                       | HMAC-SHA512 in `Authorization` header over `RequestTimestamp + body` [V]                                                                                                                                   | Void same-day [V]; refund API path/partial UNVERIFIED                                                          | Public sandbox base URL; credentials how-to UNVERIFIED; path says `international`, Egypt applicability UNVERIFIED | Docs yes                                                                                                                                                                                                        |
| PaySky                                  | https://paysky.io/docs/ [V partial]                                    | MerchantId + TerminalId + Merchant Secret Key (hex)                                                                                                                                                                                                          | Lightbox JS                                                                                                                        | `SecureHash` HMAC-SHA256 over sorted `name=value&...` [V]                                                                                                                                                  | UNVERIFIED                                                                                                     | UNVERIFIED (likely contact PaySky)                                                                                | Partial                                                                                                                                                                                                         |
| EasyKash                                | https://www.easykash.net/                                              | UNVERIFIED                                                                                                                                                                                                                                                   | UNVERIFIED                                                                                                                         | UNVERIFIED                                                                                                                                                                                                 | UNVERIFIED                                                                                                     | UNVERIFIED                                                                                                        | No public docs found                                                                                                                                                                                            |
| Aman, Masary                            | e-masary.com                                                           | no public API found                                                                                                                                                                                                                                          | kiosk / cash points                                                                                                                | n/a                                                                                                                                                                                                        | n/a                                                                                                            | n/a                                                                                                               | Partner-only; Aman is reachable via Paymob/PayTabs (UNVERIFIED)                                                                                                                                                 |
| valU, Sympl, Souhoola (direct)          | no public merchant API found                                           | n/a                                                                                                                                                                                                                                                          | via gateway                                                                                                                        | via gateway                                                                                                                                                                                                | via gateway                                                                                                    | n/a                                                                                                               | Partner-only. Via Paymob (valU/Sympl/Souhoola/Halan/TRU/MOGO listed [V]), Fawry (VALU [V], Souhoola on checkout page), Geidea (valU needs merchant's own valU Vendor/Store/Product IDs [V]), OPay (valU listed) |
| Meeza                                   | no separate API                                                        | n/a                                                                                                                                                                                                                                                          | via acquirer                                                                                                                       | via acquirer                                                                                                                                                                                               | via acquirer                                                                                                   | n/a                                                                                                               | Kashier [V], Geidea (Meeza QR/Digital) [V], PaySky, OPay, Paymob UNVERIFIED                                                                                                                                     |
| Tabby / Tamara                          | docs.tabby.ai, Tamara docs                                             | n/a                                                                                                                                                                                                                                                          | n/a                                                                                                                                | n/a                                                                                                                                                                                                        | n/a                                                                                                            | n/a                                                                                                               | Docs name KSA/UAE only. Tabby reportedly left Egypt in 2023 (UNVERIFIED). Treat as NOT available                                                                                                                |
| InstaPay                                | cbe.org.eg IPN page                                                    | none public                                                                                                                                                                                                                                                  | manual / via Kashier                                                                                                               | none                                                                                                                                                                                                       | n/a                                                                                                            | n/a                                                                                                               | No merchant API; Kashier exposes it (2.12)                                                                                                                                                                      |
| NBE / CIB / Banque Misr hosted checkout | NBE developer host unreachable                                         | bank corporate agreement                                                                                                                                                                                                                                     | bank-hosted page (MPGS-style, UNVERIFIED)                                                                                          | UNVERIFIED                                                                                                                                                                                                 | UNVERIFIED                                                                                                     | UNVERIFIED                                                                                                        | Partner-only                                                                                                                                                                                                    |
| Stripe / PayPal                         | stripe.com/global [V]                                                  | n/a                                                                                                                                                                                                                                                          | n/a                                                                                                                                | n/a                                                                                                                                                                                                        | n/a                                                                                                            | n/a                                                                                                               | Egypt not on Stripe's supported list [V]; PayPal receiving restricted (UNVERIFIED). Out of scope                                                                                                                |

Fees (all UNVERIFIED, third-party/search snippet, not official): Paymob and Kashier ~2.75% + EGP 3 + 14% VAT
on the fee; Fawry, Geidea, OPay, PaySky negotiated. Settlement cadence and KYC (commercial register, tax
card, owner ID, bank account; days to approve) are UNVERIFIED everywhere; they are merchant-facing help text
only, never code. Do not quote fees in the product.

### 2.2 Key facts per integration style

- **Where the signature lives differs for every gateway** (query, header, body, Authorization header). The
  existing `extractWebhookSignature` switch is the right seam; each new gateway adds one case.
- **Three signature families:** HMAC over named fields (Paymob SHA-512, Kashier SHA-256, Geidea SHA-256
  Base64, PaySky SHA-256), HMAC over timestamp+body (OPay SHA-512), plain SHA-256 with secret appended (Fawry).
  Always constant-time compare (`safeEqual` exists in `gateway-http.ts`).
- **Never trust the redirect/return URL or iframe `postMessage`;** confirm via the signed webhook or a
  server-side status call (Kashier's docs say the same).
- **Idempotency:** none of these gateways documents an idempotency header. Keep the existing local
  `IdempotencyCache` + unique merchant reference per attempt.
- **Mode:** Paymob test and live share one host (keys decide); Kashier has separate hosts and a test key never
  validates on live. The form must therefore store test and live key sets separately, or make the mode switch
  force re-entry (see 4.3).

### 2.3 Harmless "Test connection" call per gateway

| Provider | Call                                                                                                                                                      | Proves                                                 | Status                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| Paymob   | `POST /api/auth/tokens {api_key}` -> 201 + token                                                                                                          | API key only, not secret/public key or integration IDs | [V]                                         |
| Kashier  | account-info or `getMerchantPaymentMethods` with the secret key                                                                                           | secret key + entitled methods                          | exact URL UNVERIFIED (listed in `llms.txt`) |
| Fawry    | status v2 with a dummy `merchantRefNumber` and a correct signature; expect "order not found" (9938) vs invalid merchant (9901) / invalid signature (9946) | merchantCode + secureKey, no side effect               | codes [V] on the wallet page                |
| Geidea   | `GET /pgw/api/v1/direct/order?Take=1`, Basic auth                                                                                                         | public key + password                                  | [V] documented                              |
| OPay     | status query with HMAC auth                                                                                                                               | private key                                            | path UNVERIFIED (page 404)                  |
| PaySky   | signed Data Service `FilterTransactions`                                                                                                                  | secret key                                             | UNVERIFIED                                  |

A green test means "credentials accepted", not "a payment will work". Paymob additionally needs the integration
IDs to match the currency; validate by listing them if an endpoint exists (UNVERIFIED), else show a one-time
"place a 1 EGP test order" step in test mode.

## 3. Shipping

### 3.0 What Ebda has today

`apps/api/src/services/carriers/`:

- `ShippingCarrierProvider` (`types.ts`): `capabilities {quote,label,webhooks,polling,cod}`, `createShipment`
  (MUST be idempotent on `merchantReference`), `trackShipment`, `cancelShipment`, optional `getLabel` and `quote`,
  `processWebhook(body, headers)` (authentication is the service's job), `testConnection`. `CarrierCallContext`
  carries non-secret `settings` and a per-store `callbackUrl`. COD in piastres, converted at the edge. Typed
  `CarrierError` (unavailable = retry; rejected; misconfigured; `COD_NOT_SUPPORTED`; `NEEDS_MAPPING`).
- `CARRIER_CODES = ['icarry','aramex','bosta','manual']`. Adapters: bosta, aramex, icarry (inherited/legacy), manual.
- Storage: `ShippingCarrierConfig` = one encrypted JSON string `credentials` + `settings` JSON per
  (store, carrier). Open string map credentials; `baseUrl` is SSRF-checked in `carrier-http.ts` / `safe-fetch.ts`.
- Routes `shipping-carrier.routes.ts` (config CRUD, `POST /:storeId/shipping-carriers/test/:carrier`, ship,
  cancel, label, quote, shipments list, COD report, settlement CSV import). Webhooks:
  `/webhooks/shipping/bosta/:storeId/:token` (secret path token), `/webhooks/shipping/icarry` (global secret).
  Aramex is polled by the tracking cron.
- Admin: per-carrier cards (`BostaCarrierCard`, `AramexCarrierCard`, `ICarryCarrierCard`, `ManualCarrierCard`).

### 3.1 Carrier matrix

| Carrier                               | Docs                                                                                                                                      | Auth                                                                                                                                   | Create / label                                                                                                         | Rates                                                                           | Pickup                                         | Tracking                                                                                                                                                           | COD + remittance                                                                               | Cancel                                                        | Sandbox                                                  | Areas API                                                                                  | Public?                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **Bosta**                             | https://docs.bosta.co/ [V]                                                                                                                | `Authorization: <API key>` (no Bearer); key from dashboard Settings > API Integration with OTP, scopes Read/Read-Write/Full [V]        | `POST /deliveries?apiVersion=1`, bulk; `POST /deliveries/mass-awb` A4/A6, ar/en, base64 PDF (<=50) [V]                 | route `GET /pricing/shipment/calculator` exists (401 unauth); params UNVERIFIED | `POST /pickups` [V]                            | **Webhook**: POST on each state change; auth = static header you configure (dashboard or per-delivery `webhookCustomHeaders`), no HMAC [V]; polling also available | `cod` on create; collected `cod` in Delivered webhook [V]; remittance API UNVERIFIED           | terminate delivery (DELETE path UNVERIFIED); states 48/49 [V] | `stg-app.bosta.co` live; account provisioning UNVERIFIED | `GET /cities`, `/cities/{id}/zones`, `/cities/getAllDistricts` answer **without auth** [V] | Yes                                                                                |
| **ShipBlu**                           | https://docs.shipblu.com + OpenAPI https://api.staging.shipblu.com/docs/?format=openapi [V]                                               | `Authorization: Api-Key <key>` from merchant portal > Integrations [V]                                                                 | `POST /v1/delivery-orders/`; `GET /v1/delivery-orders/{id}/shipping-label/`, `/v1/orders/shipping-label/` pdf/html [V] | `POST /v1/pricing/orders/{order_type}/` [V]                                     | `POST /v1/delivery-orders/request-pickup/` [V] | polling; no webhook in spec or docs [V by absence]                                                                                                                 | cash-collection ORDER type exists (not remittance); COD flag on delivery UNVERIFIED            | status CANCELLED documented, call UNVERIFIED                  | email tech@shipblu.com [V]                               | `/v1/governorates/`, `/{id}/cities/`, `/cities/{id}/zones/` (key required) [V]             | Yes                                                                                |
| **Mylerz**                            | Swagger https://integration.mylerz.net/swagger , spec `/swagger/docs/v1` [V]                                                              | `POST /token` password grant -> Bearer (creds from Mylerz sales)                                                                       | `POST /api/Orders/AddOrders`; `POST /api/packages/GetAWB` [V]                                                          | `POST /api/packages/GetExpectedCharges` [V]                                     | `CreatePickupOrder` [V]                        | polling only (`TrackPackages`, `GetPackageStatus`) [V by absence of webhook]                                                                                       | payment type COD/CC/PP; `UpdatePackageCodValue`; no remittance report [V by absence]           | `POST /api/packages/CancelPackage` [V]                        | none public (UNVERIFIED)                                 | `GetCityZoneList`, `GetSubZoneList/{zone}`, `GetZoneByAddress` [V]                         | Spec public, creds gated                                                           |
| **Aramex**                            | portal 403s bots; WSDLs public: `ws.aramex.net/ShippingAPI.V2/{Shipping,RateCalculator,Tracking,Location}/Service_1_0.svc?singleWsdl` [V] | `ClientInfo` in every SOAP body: UserName, Password, AccountNumber, AccountPin, AccountEntity, AccountCountryCode, Source, Version [V] | `CreateShipments`, `PrintLabel` [V]                                                                                    | `CalculateRate` [V]                                                             | `CreatePickup` [V]                             | polling (`TrackShipments`); no push op [V by absence]                                                                                                              | `CashOnDeliveryAmount` field exists [V]; domestic EGP acceptance and remittance API UNVERIFIED | **no CancelShipment op in WSDL** [V by absence]               | `ws.dev.aramex.net` UNVERIFIED                           | `FetchCities/States/Countries`, `ValidateAddress` [V]                                      | Public WSDL, account via Aramex                                                    |
| **DHL Express**                       | https://developer.dhl.com/api-reference/dhl-express-mydhl-api [V]                                                                         | HTTP Basic, needs DHL Express account                                                                                                  | shipments + label, customs [V]                                                                                         | rates/products [V]                                                              | create/modify/cancel pickup [V]                | MyDHL tracking; push via separate Unified Push API (auth UNVERIFIED)                                                                                               | no domestic EG COD (UNVERIFIED); international only                                            | UNVERIFIED                                                    | `.../mydhlapi/test`, 500/day [V]                         | address-validate only                                                                      | Yes (account needed)                                                               |
| **FedEx**                             | https://developer.fedex.com                                                                                                               | OAuth2 client_credentials, `apis-sandbox.fedex.com` [V]                                                                                | Ship/Rate/Track/Pickup UNVERIFIED (catalog is JS-gated)                                                                | UNVERIFIED                                                                      | UNVERIFIED                                     | UNVERIFIED                                                                                                                                                         | international express, no domestic COD (UNVERIFIED)                                            | UNVERIFIED                                                    | yes [V]                                                  | n/a                                                                                        | Yes, international only                                                            |
| **UPS**                               | https://developer.ups.com                                                                                                                 | OAuth2 client credentials                                                                                                              | Shipping, Pickup, Address Validation listed [V]                                                                        | UNVERIFIED                                                                      | listed [V]                                     | UNVERIFIED                                                                                                                                                         | none relevant                                                                                  | UNVERIFIED                                                    | CIE UNVERIFIED                                           | n/a                                                                                        | Yes, international only                                                            |
| **J&T Express EG**                    | open.jtjms-eg.com (captcha SPA, unreadable); API host `openapi.jtjms-eg.com/webopenplatformapi/api` live [V]                              | UNVERIFIED (3rd-party: headers apiAccount, timestamp, digest = base64(md5(bizContent+privateKey)))                                     | UNVERIFIED (addOrder/printOrder)                                                                                       | UNVERIFIED                                                                      | UNVERIFIED                                     | UNVERIFIED (digest-signed push)                                                                                                                                    | UNVERIFIED                                                                                     | UNVERIFIED                                                    | UNVERIFIED                                               | UNVERIFIED (Arabic location tree)                                                          | Credentials from J&T sales: partner-gated                                          |
| **R2S**                               | none found                                                                                                                                | UNVERIFIED                                                                                                                             | UNVERIFIED                                                                                                             | -                                                                               | -                                              | -                                                                                                                                                                  | -                                                                                              | -                                                             | -                                                        | -                                                                                          | Partner-only (ClickPost lists it: 3rd-party)                                       |
| **Turbo**                             | https://turbo.info/en/developers/ is a JS SPA, unreadable by our tools                                                                    | UNVERIFIED                                                                                                                             | UNVERIFIED                                                                                                             | -                                                                               | -                                              | -                                                                                                                                                                  | -                                                                                              | -                                                             | -                                                        | -                                                                                          | Possibly public; open in a browser                                                 |
| **Sprint**                            | sprint.xyz/technology: "integrates with ecommerce platforms", no docs [V]                                                                 | -                                                                                                                                      | -                                                                                                                      | -                                                                               | -                                              | -                                                                                                                                                                  | -                                                                                              | -                                                             | -                                                        | -                                                                                          | No public API found                                                                |
| **Egypt Post / EMS**                  | none                                                                                                                                      | -                                                                                                                                      | -                                                                                                                      | -                                                                               | -                                              | tracking only via 3rd-party trackers                                                                                                                               | -                                                                                              | -                                                             | -                                                        | -                                                                                          | No merchant API found                                                              |
| **Flash Express**                     | https://open-docs.flashexpress.com/ [V]                                                                                                   | mchId + nonceStr + sign                                                                                                                | yes                                                                                                                    | -                                                                               | -                                              | webhook                                                                                                                                                            | -                                                                                              | yes                                                           | training host                                            | -                                                                                          | **Does not operate in Egypt** (TH, MY, PH, LA only) [V]. Out of scope              |
| **Shipox / ShipX white-label**        | info.shipx.com dev portal (register, 1-3 days approval) [V]; legacy docs shipox.docs.apiary.io                                            | token via Shipox creds (UNVERIFIED details)                                                                                            | UNVERIFIED                                                                                                             | -                                                                               | -                                              | -                                                                                                                                                                  | -                                                                                              | -                                                             | TEST/LIVE modes in WooCommerce plugin [V]                | -                                                                                          | Tenant-specific base URL per courier; which Egyptian couriers run on it UNVERIFIED |
| Fetchr, Lamar, Khazna, Nimbus, Dakhli | -                                                                                                                                         | -                                                                                                                                      | -                                                                                                                      | -                                                                               | -                                              | -                                                                                                                                                                  | -                                                                                              | -                                                             | -                                                        | -                                                                                          | Fetchr liquidated 2021; the others are not Egyptian couriers or nothing found      |
| Aggregators                           | Shippo/EasyPost/ShipEngine front DHL/FedEx/UPS only; SIDEUP is a merchant dashboard                                                       | -                                                                                                                                      | -                                                                                                                      | -                                                                               | -                                              | -                                                                                                                                                                  | -                                                                                              | -                                                             | -                                                        | -                                                                                          | **No public multi-carrier Egyptian API.** Per-carrier adapters only                |

Observations that shape the design:

- Only Bosta pushes tracking (plus DHL's separate push API). ShipBlu, Mylerz, Aramex are polled; the existing
  cron + `capabilities.polling` covers them.
- **Bosta webhook auth:** the official docs describe a shared-secret HEADER (`webhookCustomHeaders`). The current
  adapter says "Bosta signs nothing" and uses a secret URL path token. Keep the path token (stronger: unguessable
  and per-store) and ALSO set a custom header per delivery so a leaked URL alone is not enough. Cheap, [V].
- **Address mapping is mandatory:** Bosta cityCode + zoneId/districtId, ShipBlu zone integer id, Mylerz zone +
  sub-zone code, Aramex city name, J&T Arabic tree. Bosta's lists are public (no key), so the mapper can be
  pre-seeded and snapshot-tested; others need the merchant's key to fetch.
- **COD remittance:** no public API anywhere. Keep `cod-reconciliation.service` + CSV import; add per-carrier
  CSV column maps for the statements merchants download from each portal.
- **Aramex has no cancel op in the WSDL:** `cancelShipment` must answer `not_cancellable` with an instruction to
  cancel in the Aramex portal, unless Aramex docs (403 to our tools) say otherwise. Do not call it verified.
- **Aramex COD currency** (one third party says USD only) stays UNVERIFIED; the adapter already refuses COD
  when `cod: 'unconfirmed'`.

### 3.2 Harmless "Test connection" call per carrier

| Carrier     | Call                                                                           | Notes                                                          |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Bosta       | authed `GET` on pickups / pickup-locations; 401 `errorCode 1028` = bad key [V] | `GET /cities` needs no key, so it proves nothing about the key |
| ShipBlu     | `GET /api/v1/merchants/` (official quick-start test) [V]                       | returns merchant id + name; show the name back to the merchant |
| Mylerz      | `POST /token`, then `GET /api/Orders/GetWarehouses`                            | the pre-registered warehouse list also feeds pickup settings   |
| Aramex      | `Location/FetchCountries` with `ClientInfo`                                    | failure shape UNVERIFIED                                       |
| DHL         | `GET /address-validate` or `/products` on `/test`                              |                                                                |
| FedEx / UPS | token endpoint                                                                 |                                                                |

## 4. Design: generic "connect a provider"

### 4.1 Provider catalog (the one new concept)

A single code-level catalog, one entry per provider, shared by `payments` and `carriers` kinds. It is data, not
UI code. The merchant never sees code; the admin renders the form from it.

```ts
// packages/shared/src/providers/catalog.ts (sketch)
type FieldDef = {
  key: string; // 'secretKey', 'integrationIds.card'
  label: { en: string; ar: string };
  kind: 'secret' | 'text' | 'select' | 'boolean' | 'idMap';
  required: boolean;
  modes?: ('sandbox' | 'live')[]; // which mode set this field belongs to
  pattern?: string; // client + server validation (e.g. /^sk_(test|live)_/)
  help: { en: string; ar: string; whereToFind: string; docUrl: string; dashboardUrl?: string };
};
type ProviderDef = {
  kind: 'payment' | 'carrier';
  code: string; // 'paymob', 'bosta'
  name: { en: string; ar: string };
  logo: string;
  fields: FieldDef[]; // credentials (secret) + settings (non-secret)
  capabilities: ProviderCapabilities | CarrierCapabilities; // existing types, reused
  webhook?: {
    mode: 'signed-header' | 'signed-query' | 'signed-body' | 'path-token';
    setupHelp: { en: string; ar: string };
  };
  testConnection: 'adapter'; // implemented by the adapter, never by the catalog
  status: 'verified' | 'stub-only' | 'experimental'; // gates visibility, see 4.6
};
```

- The Zod schema for credential input is derived from `fields` (single source of truth), and the existing
  per-provider schemas (`paymobSettingsBaseSchema` etc.) become generated or are asserted equal in a test.
- Adding a provider = one catalog entry + one adapter implementing the EXISTING `PaymentProviderV2` /
  `ShippingCarrierProvider` interface + a webhook-signature case. No new admin card, no per-provider route.
- `PaymentProvider` ceases to be a closed Postgres enum: change `PaymentConfig.provider` to `String` validated
  against the catalog (one migration, then no migration per gateway). `CarrierCode` already is a string column.

### 4.2 Settings UX

1. **Pick provider:** grid of catalog cards filtered by kind, each showing capability chips (Cards, Wallets,
   Installments, COD, Labels, Webhooks) and a status badge. Only `verified` providers appear by default.
2. **Credentials form (schema-driven):** one field per `FieldDef`, secret fields masked, each with a help line
   and a "Where do I find this?" link (`dashboardUrl` opens the provider's own page) plus the doc link.
   Paymob's `integrationIds` render as a repeating "method -> integration ID" table (`idMap`), exactly what the
   adapter already expects. Arabic and English copy per field (default locale is Arabic).
3. **Webhook setup box:** shows the per-store URL with a copy button and the exact place to paste it
   (`setupHelp`). Paymob and Fawry need the merchant to paste it into their dashboard; Kashier and Bosta take
   it per request, so the box says "automatic" for those.
4. **Test connection:** disabled until required fields are filled; calls the adapter's harmless call (2.3, 3.2);
   result is one of: connected (with what we learned: merchant name, entitled methods), bad credentials, wrong
   mode (test key on live), unreachable (retry), or "credentials accepted, setup incomplete" (e.g. no
   integration IDs). Never echoes the secret or the raw provider error body.
5. **Enable:** the toggle is disabled until the last Test connection succeeded for the CURRENT credential
   values (store a `credentialsHash` + `lastTestedAt`; any edit invalidates it). Disabling is always allowed.
6. **Health:** reuse `provider-health.ts` and the circuit breaker; show degraded/down in the same card.

### 4.3 Credential storage and handling

- Keep the existing model: AES-256-GCM via `encryption.service`, decrypted only inside the provider call,
  never logged (`describeForLog`), never returned (masked `****` + last 4 captured at save time), never in
  `payments.metadata`.
- **Carrier credentials are one encrypted JSON blob** today; payments use fixed columns (`apiKey`, `secretKey`,
  `merchantId`, `webhookSecret`). Gateways with more than four secrets (Kashier test+live pairs, OPay public +
  private + merchant id, PaySky MID + TID + key, Geidea) do not fit the columns. Plan: move payments to the
  carrier shape (encrypted JSON `credentials` per (store, provider), plus `mode`), keep the old columns readable
  during a two-step migration, and fingerprint every `secret` field (last 4) into a non-secret map for display.
- **Sandbox vs live:** store two credential sets per provider (`credentials.sandbox`, `credentials.live`) and a
  `mode` flag, so switching mode does not make the merchant retype keys and a test key can never be sent to a
  live host (Kashier explicitly rejects this). Mode switch re-runs Test connection.
- **Rotation:** saving a masked (`****`) value keeps the stored secret (existing `preserveMaskedCredentials`).
  Add an audit-log entry per credential change (who, which provider, which fields; never values).
- **SSRF:** no merchant-supplied `baseUrl` for providers with fixed hosts; the catalog pins the host per mode.
  A free `baseUrl` stays only for self-hosted/white-label systems (Shipox) and goes through `safe-fetch`.
- **Access:** only `store_admin` / `super_admin` with store access (existing chain); secrets are write-only.

### 4.4 Webhook routing per store (existing pattern, extended)

- Payments: keep `POST /webhooks/payment/:provider`, store resolved from references in the body through the
  `ebda_webhook_resolve_store` definer, signature verified over the raw body with that store's secret, inbox
  idempotency on `eventId`. Per new gateway: one case in `extractWebhookSignature` (+ OPay timestamp header,
  Geidea unknown transport) and one in the reference extractor.
- Carriers: keep `/webhooks/shipping/:carrier/:storeId/:token` (per-store secret path token); generalise the
  Bosta route to `:carrier`. Add the custom-header secret where the carrier supports it.
- The webhook URL shown in settings is derived from the catalog `webhook.mode` and the store, so the merchant
  copies it from one place.

### 4.5 Contract-test strategy

Existing adapters are tested against local stubs written from unverified assumptions, so the green suite proves
nothing about the real provider. Fix that in layers:

1. **Recorded official sandbox responses (golden fixtures).** For every provider with a self-serve sandbox
   (Kashier, Paymob, Fawry; Bosta/ShipBlu once staging accounts exist), a `record` script run by a human with
   sandbox keys replays the adapter's calls (create, status, refund, webhook, test-connection, areas) against
   the real sandbox and writes sanitized JSON (secrets, PII, ids redacted) to `tests/contracts/<provider>/`.
   CI replays the fixtures through an in-process HTTP stub and asserts the adapter's requests (method, path,
   headers shape, body) match the recorded REQUEST too, so a drift on either side fails. Fixture header records
   the date, host, and doc URL.
2. **Official test vectors for signatures.** Paymob HMAC checker (wizard.paymob.com, UNVERIFIED availability),
   Fawry/Kashier doc examples: hard-code the doc's own example inputs and expected hashes as unit tests, with a
   mutation check (flip one field, expect rejection; this catches the "passes for the wrong reason" class).
3. **OpenAPI/WSDL-derived checks where the vendor publishes a spec:** ShipBlu OpenAPI, Mylerz Swagger, Aramex
   WSDLs, Bosta (Stoplight spec if obtainable). Validate request bodies against the spec in tests.
4. **Public no-auth endpoints are live-testable in CI nightly:** Bosta `/cities`, `/zones`, `/districts` (no
   key needed) refresh the area map snapshot and detect schema drift.
5. **Stub status is explicit:** the catalog `status` field is `stub-only` until a fixture recorded from the real
   sandbox exists for create + webhook + refund; only then `verified`. The UI hides `stub-only` providers
   from merchants (visible to super_admin), so we never advertise an unverified integration.
6. **Production smoke:** a per-provider synthetic "Test connection" on a schedule against Ebda's own sandbox
   keys, alert on shape change (reuses the existing alert bridge).

### 4.6 What we can and cannot verify without merchant keys

| Without any provider keys                                                                                                                                                                                     | Needs a sandbox signup (no merchant)                                                                                                     | Needs a real merchant account                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signature algorithms against official doc vectors; request-shape vs OpenAPI/WSDL; Bosta public area lists; address mapper logic; form rendering; encryption/masking; Test connection error mapping with stubs | Kashier, Paymob, Fawry sandbox: full create/redirect/webhook/refund recording; Bosta + ShipBlu staging (ShipBlu by email, Bosta account) | Live settlement/remittance, BNPL and kiosk (Paymob sandbox cannot test them), Apple Pay certificates, valU vendor IDs, COD remittance timing, real fees, Aramex/J&T/Mylerz credentials |

## 5. Existing code vs this plan: gaps found while reading

1. `PaymentProvider` union and DB enum are closed; every new gateway costs a migration + card (fix in 4.1).
2. Payment credentials are four fixed columns; OPay/PaySky/Geidea/Kashier-pairs do not fit (4.3).
3. No "tested and still valid" gate on enabling a provider (4.2 step 5).
4. Bosta webhook uses only a path token; the docs allow a header secret too (3.1).
5. Aramex `cancelShipment`: the WSDL has no cancel op; verify the adapter does not pretend to cancel.
6. Webhook signature extractor has no case for header-timestamp schemes (OPay) or unknown-transport (Geidea).
7. Admin carrier area is four hand-built cards; ShipBlu/Mylerz would be two more unless 4.1 lands first.

## 6. Per-provider effort (engineer-days, one engineer, includes tests and fixtures; excludes sandbox wait time)

Assumes the catalog framework (4.1-4.4) is built first: **framework 8 to 10 days** (catalog, schema-driven form,
credential JSON migration, test-connection plumbing, enable gate, audit log, generalised webhook routes).

| Provider                                   | Kind | Days        | Notes                                                                           |
| ------------------------------------------ | ---- | ----------- | ------------------------------------------------------------------------------- |
| Paymob: verify vs sandbox                  | pay  | 2           | adapter exists; close the UNVERIFIED items, record fixtures, settle refund path |
| Kashier: verify                            | pay  | 2           | + InstaPay via `/v3/orders` (+2)                                                |
| Fawry: verify                              | pay  | 2           | signatures already documented [V]                                               |
| Geidea                                     | pay  | 4           | new adapter; transport of signature UNVERIFIED                                  |
| OPay                                       | pay  | 4           | new; auth differs per endpoint; Egypt applicability unconfirmed                 |
| PaySky                                     | pay  | 4           | Lightbox flow, partial docs                                                     |
| Bosta: verify + areas + header secret      | ship | 3           | adapter exists                                                                  |
| ShipBlu                                    | ship | 4           | OpenAPI-driven; polling; zone mapper                                            |
| Mylerz                                     | ship | 5           | token flow, warehouse prerequisite, zone mapper                                 |
| Aramex: verify                             | ship | 3           | SOAP; cancel limitation; COD currency                                           |
| DHL Express                                | ship | 4           | international only; Basic auth, `/test` host                                    |
| FedEx or UPS                               | ship | 5 each      | international only; low priority                                                |
| J&T, R2S, Turbo, Shipox couriers           | ship | 4 to 6 each | blocked until docs/creds obtained                                               |
| Manual wallet transfer variant of InstaPay | pay  | 1           | same state machine                                                              |

## 7. Prioritised batches

**Batch 0 (prerequisite): framework** (4.1 to 4.4) and fixture recorder (4.5). 8 to 10 days.

**Batch 1 (verify what exists, highest merchant usage): ~15 days incl. framework share**

- Payments: Paymob, Kashier, Fawry (verified against sandbox, flip catalog `status` to `verified`).
  Rationale: they already cover cards, Meeza, Vodafone/Orange/e&/WE wallets, valU/Sympl/Souhoola, kiosk, Apple Pay,
  and InstaPay (via Kashier). That is the full method list a typical Egyptian store needs.
- Shipping: Bosta (hardening), ShipBlu, Mylerz. Bosta is the dominant e-commerce courier; ShipBlu and Mylerz
  have public specs we can build and test against offline.
- Always on: COD, InstaPay manual, manual carrier (already shipped).

**Batch 2 (breadth): ~15 days**

- Payments: Geidea, OPay Egypt. Shipping: Aramex verification (COD currency, cancel), DHL Express (for
  international orders).
- Kashier InstaPay QR/R2P; manual wallet-transfer variant.

**Batch 3 (on merchant demand or after docs/credentials arrive)**

- PaySky, J&T Express, Turbo (confirm docs in a browser), R2S, Shipox couriers, FedEx/UPS, direct valU/Sympl/
  Souhoola/Aman/Masary/EasyKash (all partner-only: each needs a commercial conversation, not engineering).
- Do not build: Tabby/Tamara (not in Egypt), Stripe/PayPal (not viable), Flash Express (not in Egypt).

## 8. Blockers and open questions for Ahmad

1. **Sandbox accounts:** Whisky 11 needs signup under the company email for Paymob, Kashier, Fawry (self-serve),
   Bosta staging, ShipBlu (email tech@shipblu.com), and ideally Mylerz and Geidea (sales contact). Without these,
   Batch 1 stays `stub-only` by definition.
2. **Docs we could not read:** Aramex portal (403), J&T portal (captcha), Turbo (SPA), Bosta API reference
   (Stoplight JS). Someone must open them in a browser and save the pages/PDFs, or we request the PDFs.
3. **Decision:** accept the `PaymentProvider` enum -> string migration and credential JSON move (touches money
   tables; needs the staged migration and a rollback recipe).
4. **Decision:** show `stub-only` providers to merchants? Recommendation: no (super_admin only).
5. Fees, settlement cadence and onboarding documents are UNVERIFIED everywhere; the settings help text should
   link to the provider's own page, not state numbers.

## 9. Sources

All fetched 2026-10-07 unless noted. [V] in the text means the page below stated the fact.

- Paymob: https://developers.paymob.com/paymob-docs/getting-started/overview ; .../developers/intention-apis/create-intention ;
  .../developers/getting-integration-credentials ; .../developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback ;
  .../developers/authentication-request-generate-auth-token-1 ; .../developers/manage-payment-apis/void ; .../refund
- Fawry: https://developer.fawrystaging.com/ ; /docs/server-apis/create-payment-refno-apis ; /docs/payment-notifications/get-payment-status-v2 ;
  /docs/payment-notifications/server-notification-v2 ; /docs/server-apis/refund-issue-api ; /docs/express-checkout/fawrypay-hosted-checkout ;
  /docs/express-checkout/self-hosted-checkout ; /docs/server-apis/mobile-wallet-payment
- Kashier: https://developers.kashier.io/ ; /docs/get-started/api-keys ; /docs/accept-payments/payment-sessions ; /docs/accept-payments/refunds ;
  /payment/webhook/ ; /docs/get-started/going-live ; /docs/accept-payments/instapay
- Geidea: https://docs.geidea.net/docs/geidea-checkout-v2 ; /reference/create-session-v2-1 ; /docs/refund-2 ; /docs/sample-callback-responses ;
  /docs/fetch-all-transactions-or-search-transactions ; /docs/valu ; /docs/meeza
- OPay: https://doc.opaycheckout.com/ ; /cashier-create ; /callback-signature-v2 ; /cashier-void
- PaySky: https://paysky.io/docs/ ; https://paysky.io/docs/paysky-omni-gateway-payform-plus-integration-guide/
- Stripe supported countries: https://stripe.com/global
- Bosta: https://docs.bosta.co/ (how-to: get-your-api-key, get-your-authorization-token, create-your-first-delivery, create-your-first-pickup,
  get-delivery-status-via-webhook, print-awbs, whitelisting); https://github.com/bostaapp/bosta-nodejs ; live probes of
  https://app.bosta.co/api/v2/cities , /cities/{id}/zones , /cities/getAllDistricts and https://stg-app.bosta.co/api/v2
- ShipBlu: https://docs.shipblu.com/quick-start , /tutorial , /api-reference ; https://api.staging.shipblu.com/docs/?format=openapi ;
  https://github.com/ShipBlu/shipblu.github.io
- Mylerz: https://integration.mylerz.net/swagger ; https://integration.mylerz.net/swagger/docs/v1 ; https://wordpress.org/plugins/mylerz/
- Aramex WSDLs: https://ws.aramex.net/ShippingAPI.V2/Shipping/Service_1_0.svc?singleWsdl ; .../RateCalculator/Service_1_0.svc?singleWsdl ;
  https://ws.aramex.net/shippingapi/tracking/service_1_0.svc?singleWsdl ; .../Location/Service_1_0.svc?singleWsdl
  (portal https://www.aramex.com/us/en/developers-solution-center/aramex-apis returned 403)
- DHL: https://developer.dhl.com/api-reference/dhl-express-mydhl-api ; https://developer.dhl.com/api-reference/shipment-tracking-unified-push
- FedEx https://developer.fedex.com ; UPS https://developer.ups.com/api/reference (partial, JS-gated)
- Flash Express: https://open-docs.flashexpress.com/
- Shipox/ShipX: https://shipx.helpscoutdocs.com/article/31-developer-portal ; https://wordpress.org/plugins/shipox-for-woocommerce/
- Sprint: https://sprint.xyz/technology/
- J&T (UNVERIFIED, third-party): https://github.com/NUMU-IO/NUMU-api/pull/605 ; https://github.com/Genius-code/jt-express-eg
- Prior briefs in this repo: `docs/ebda/research/egypt-payment-providers.md`, `docs/ebda/research/egypt-shipping-carriers.md`
