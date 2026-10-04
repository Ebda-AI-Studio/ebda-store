# Egypt Payment Providers: Research Brief for Ebda

Researched: 2026-10-03

**Method note.** Most official doc portals (developers.paymob.com, developers.kashier.io, developer.fawrystaging.com, docs.shipblu.com, kashier.io) were blocked by the research sandbox's egress proxy. Facts below come from web-search snippets of those official pages, official GitHub repos, and third-party code (including open-source integrations of the same providers). Each claim carries the URL where it was seen; "as-of" is 2026-10-03 (the date fetched) unless the page shows its own date. Anything not confirmed is marked **unverified**. No fee has been invented.

## Answer

Build COD first, then a manual InstaPay confirm step, then **Paymob** as the first real gateway (broadest method coverage in one integration: cards, Meeza, wallets such as Vodafone Cash, valU and other BNPLs, plus saved cards/subscriptions and a marketplace product). **Kashier** is a close second (published 2.75% + EGP 3, simple HMAC webhooks, card-token recurring) and is the best-evidenced option for **Ebda's own EGP subscription billing**, but its recurring-agreement feature needs account enablement and was only partly proven in a competitor's code (see Kashier). Fawry matters for cash-at-kiosk reference codes. valU is not directly integrable (it reaches merchants through aggregators). InstaPay has no public merchant checkout API that we could verify; plan on manual transfer + proof + one merchant-confirm click. The key platform-model finding: for all gateways, assume **each merchant brings their own keys** (BYO-keys) at launch; only Paymob advertises a marketplace/split product, and its terms for a platform like Ebda are **unverified**.

## Decision table

| Provider | API style | Sandbox | Fee (published) | Webhook auth | Partial refund API | Saved card / recurring | Platform / sub-merchant |
|---|---|---|---|---|---|---|---|
| Paymob Accept | REST, "Intention" API, hosted checkout | Yes, self-serve test mode (30-day expiry note) | 2.75% + EGP 3 | HMAC-SHA512 in `hmac` query param | Yes (refund, void, capture) | Yes: CIT/MIT, subscription plans | Marketplace/split product exists; terms unverified |
| Kashier | REST, hosted + embedded sessions | Yes (`test-api.kashier.io`) | 2.75% + EGP 3 (+14% VAT on fee) | HMAC-SHA256, `x-kashier-signature` header | Yes (`PUT /v3/orders/:id`) | Card token + recurring; agreement needs account enablement | **unverified** (assume BYO keys) |
| Fawry / FawryPay | REST server API + SDKs | Yes (staging portal) | **unverified** (negotiated) | SHA-256 `messageSignature` over concatenated fields + secureKey | Yes (refund API, amount in 2dp) | Tokenization exists (customerProfileId); recurring detail **unverified** | **unverified** |
| valU (BNPL) | No direct merchant API | n/a | **unverified** (via aggregator) | via aggregator | via aggregator | n/a | via Paymob / Geidea / Fawry / OPay |
| Meeza cards | Via acquirer (Paymob, Geidea, PaySky, Kashier) | via acquirer | via acquirer | via acquirer | via acquirer | n/a | n/a |
| Wallets (Vodafone Cash etc.) | Via aggregator only | via aggregator | via aggregator | via aggregator | via aggregator | n/a | n/a |
| InstaPay | No verified merchant API | n/a | P2P: 0.1%, min 0.50, max 20 EGP (consumer side) | n/a | n/a | n/a | n/a |
| Geidea | REST, hosted checkout + direct API | Not self-serve (**unverified**) | Negotiated, not public | HMAC-SHA256 base64 signature | Yes (full/partial) | Yes (tokenization API, MIT) | **unverified** |
| PaySky | PayForm Plus / Lightbox JS | **unverified** | **unverified** | **unverified** | **unverified** | **unverified** | n/a |
| OPay | REST cashier API | Yes (`sandboxapi.opaycheckout.com`) | **unverified** | **unverified** | **unverified** | **unverified** | **unverified** |

## Provider detail

### Paymob (Accept)
- **Docs:** https://developers.paymob.com/hub/egypt (blocked from here; seen via search listing). Official AI skill repo with Intention API/HMAC reference: https://github.com/PaymobAccept/Paymob-AI-Integration-Skill. Postman collections: https://github.com/PaymobAccept/API-Postman-Collections.
- **API:** Intention API; Egypt base URL `https://accept.paymob.com` (Paymob skill repo, as of 2026-10-03). Methods: cards (3DS, MOTO, card-on-file, auth/capture), wallets (Vodafone Cash, Orange, e&, WePay), 15+ BNPLs including valU, Apple Pay (needs certificates). Google Pay not yet in Egypt (same repo).
- **Sandbox:** yes; test cards/wallets/OTPs documented; the repo notes a "30-day sandbox expiry" and that sandbox cannot test kiosk or BNPL. Keys come from the merchant dashboard after signup (exact steps **unverified**). Tools: integration wizard https://wizard.paymob.com/ (includes HMAC checker), webhook inspector https://hooks.paymob.com.
- **Fees:** 2.75% + EGP 3 standard, no monthly fee, enterprise rates on request (https://paymob.com/en/pricing via search snippet; also reported by https://www.kerolosxgad.com/writing/payment-gateways-egypt-comparison). As of 2026-10-03; confirm on the live page before quoting to merchants.
- **Settlement:** sources conflict: weekly per pricing page; T+1 for cards/Apple Pay/Google Pay per another source (search results, 2026-10-03). **Unverified** which applies to a new small merchant.
- **KYC:** commercial registration, tax card, bank account, compliance review; 3-7 days onboarding (search summary of third-party sources, 2026-10-03; **unverified** against Paymob).
- **Refunds:** full and partial refund, void (same-day), capture (Paymob developer hub listing, https://developers.paymob.com/hub/egypt).
- **Webhooks:** "Transaction processed" callback POST. HMAC is **SHA-512** over a fixed lexicographically ordered concatenation of: `amount_cents, created_at, currency, error_occured, has_parent_transaction, obj.id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded, is_standalone_payment, is_voided, order.id, owner, pending, source_data.pan, source_data.sub_type, source_data.type, success`; compared with the `hmac` query parameter (https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback, via search snippet). Use timing-safe compare.
- **Idempotency:** no idempotency-key header found. Dedupe callbacks on `obj.id` as a unique key (Paymob skill repo).
- **Recurring:** create an Intention with `subscription_plan_id`; Paymob sends a TRANSACTION webhook (activate) and a SUBSCRIPTION webhook (links subscription id) (search result citing a third-party billing integration, https://github.com/kottaby/kottaby/pull/129). Saved cards via CIT then MIT charges.
- **Platform:** third-party sources say Paymob has an explicit Marketplace product to accept payments and distribute payouts (https://www.payselect.ae/providers/paymob, search summary). Whether Ebda can onboard sub-merchants under its own master account is **unverified**; needs a sales conversation.

### Kashier
- **Docs:** https://developers.kashier.io/docs/get-started, refunds https://developers.kashier.io/docs/accept-payments/refunds, sessions https://developers.kashier.io/docs/accept-payments/payment-sessions, going live https://developers.kashier.io/docs/get-started/going-live, webhook https://developers.kashier.io/payment/webhook/ (all blocked here; seen via search snippets).
- **API:** payment sessions (hosted or embedded checkout), payment links, Apple Pay, direct API, recurring. Sandbox hosts `test-api.kashier.io`, `test-fep.kashier.io` (search snippet of developer docs, 2026-10-03).
- **Fees:** 2.75% + EGP 3 per successful transaction, no setup/monthly fee, 14% VAT on Kashier's fee only; refunded and failed transactions not charged (https://www.kashier.io/pricing, search snippet 2026-10-03). Wallet/valU/installment rates **unverified**.
- **Settlement / KYC:** **unverified** (pricing page blocked).
- **Refunds:** `PUT /v3/orders/:orderId` with the transaction in the body; partial refund by also sending `transaction.amount` (refunds doc).
- **Webhooks:** SHA-256 HMAC; order the `signatureKeys` array alphabetically, select those keys/values from the payload, compute HMAC; signature arrives in header `x-kashier-signature`, verified with the Payment API key from the dashboard Integrations section (webhook doc snippet).
- **Recurring (important for Ebda billing):** Kashier's own page says to tokenize a card once and charge it via the recurring API, with webhooks confirming each payment (https://www.kashier.io/en/payment-acceptance/subscriptions). A competitor's open-source code (https://github.com/NUMU-IO/NUMU-api/pull/678 and /681, 2026) shows: first payment with `save: true` returns `paymentMethod.card.cardToken`; renewals via Direct API. Critically, one live merchant account got 404 "This account isn't enabled for recurring agreements" when sending an `agreement` object, so they fell back to `save: true` + `interactionSource: RECURRING` token charges, with first renewal still unconfirmed. Takeaway: **request recurring-agreement enablement from Kashier in writing** before committing; the fallback path is unproven.
- **Platform:** no sub-merchant API found; **unverified**. Assume BYO keys.

### Fawry (FawryPay)
- **Docs (staging portal):** https://developer.fawrystaging.com/docs-home, server APIs https://developer.fawrystaging.com/docs/server-apis/server-apis-overview, refund https://developer.fawrystaging.com/docs/server-apis/refund-issue-api, notifications https://developer.fawrystaging.com/docs/payment-notifications/server-notification-v2 (blocked; seen via search). OpenAPI + Postman at https://github.com/api-evangelist/fawry (third-party profile).
- **API:** server-to-server REST: charges (card, 3DS, e-wallet, valU, bank installments, PayAtFawry reference numbers), refunds, cancel unpaid orders, status, installment plans. Per-request merchant code + SHA-256 over fields + shared `secureKey`.
- **Sandbox:** yes, staging portal; how keys are issued **unverified** (likely after merchant onboarding).
- **Fees, settlement, KYC:** negotiated in the merchant agreement, not public (https://www.kerolosxgad.com/writing/payment-gateways-egypt-comparison, search snippet). **Unverified** numbers.
- **Refund:** signature = SHA-256 of `merchantCode + referenceNumber + refundAmount(2dp) + reason(optional) + secureKey`; amount-based so partial refunds are supported (refund doc snippet).
- **Webhook (v2):** `messageSignature` = SHA-256 of `fawryRefNumber + merchantRefNumber + paymentAmount(2dp) + orderAmount(2dp) + orderStatus + paymentMethod + paymentRefrenceNumber(if any) + secureKey`. Note: it is a plain hash with secret appended, not HMAC. Reference lib: https://github.com/fawry-api/fawry-node.
- **Tokenization:** signature = SHA-256 of `merchantCode + customerProfileId + secureKey` (same snippet). Recurring/MIT support **unverified**.
- **Platform:** **unverified**.

### valU (BNPL)
- No direct merchant API; integrates through aggregators (Paymob, Geidea, Fawry, OPay, Amazon Payment Services) (search summary, 2026-10-03; https://docs.geidea.net/docs/valu, https://paymentservices.amazon.com/docs/payment-methods/BNPL/valU). Paymob lists valU among its BNPLs (Paymob skill repo). Paymob sandbox cannot test BNPL.
- Fees and merchant discount rate: **unverified**. valU + Bosta "installment on delivery" partnership exists (https://www.arabfinance.com/en/News/newdetails/11201, date not seen).
- Ebda implication: valU is a payment-method option inside the Paymob adapter, not its own adapter.

### Meeza
- Domestic card scheme and Meeza Digital (mobile payments). Accepted through acquirers: Paymob, Geidea (Meeza QR request-to-pay API, https://docs.geidea.net/docs/meeza-qr-apis), PaySky UPG (https://paysky.io/upg/), Fawaterak. Not a standalone provider. Ebda: expose as a method under each gateway adapter.

### Mobile wallets (Vodafone Cash, Orange, e&, WE Pay)
- Merchants reach these through aggregators, not directly (https://lobehub.com/skills/africandigitalassetframework-africa-stack-skills-vodafone-cash, third-party; Paymob skill repo lists Vodafone Cash, Orange Money, e&, WePay under wallets). Consumer wallet-transfer fees (e.g., Vodafone Cash 0.5% min 1 max 15 EGP) are per https://momocalc.com/egypt/en/vodafone-cash-fees and are not merchant fees.
- Direct manual wallet transfer + proof is the same pattern as InstaPay.

### InstaPay
- Regulator/operator: CBE Instant Payment Network (https://www.cbe.org.eg/en/payment-systems-and-services/instant-payment-network). Limits: EGP 70,000 per transaction, 120,000 daily, 400,000 monthly; the IPN supports "collect requests" to a payer by IPA or mobile number (search summary of https://www.instapay.eg and https://www.lightspark.com/knowledge/egypt-instant-payments, 2026; pages not directly fetched).
- **Merchant API:** none found that is public or self-serve. Third-party "gateways" advertise InstaPay checkout with signed webhooks (e.g., https://instapay-ruddy.vercel.app/, https://todapay.com/solution/other-local-methods/mena/instapay/), but these are unvetted and **unverified**. Bank-level collection APIs may exist for corporate clients; **unverified**.
- **Recommendation:** manual flow. Buyer pays the merchant's IPA (handle) / mobile; buyer uploads screenshot + reference; order sits `pending_manual_payment`; merchant presses one "Confirm received" button (the single manual step). Store IPA, amount, reference, proof file, confirming user id and timestamp for audit. Do not auto-confirm from screenshots.

### Geidea
- **Docs:** https://docs.geidea.net; Egypt base URL `https://api.merchant.geidea.net` (https://github.com/api-evangelist/geidea, third-party profile).
- Hosted Checkout (HPP) and direct API; HTTP Basic (public key : API password) plus HMAC-SHA256 base64 `signature` over public key, amount, currency, merchant ref, timestamp.
- Refunds: full or partial via `POST /pgw/api/v2/direct/refund`. Tokenization API for cards on file and MIT/recurring.
- Sandbox: **unverified**; profile says production credentials come after underwriting, not self-serve. Fees negotiated. valU and Meeza QR supported.

### PaySky
- Egyptian processor behind the National Switch's UPG (Meeza, Meeza Digital, Visa/MC): https://paysky.io/upg/. PayForm Plus / Lightbox JS with MID/TID: https://paysky.io/docs/paysky-omni-gateway-payform-plus-integration-guide/. Fees, sandbox, refunds, webhooks, KYC: **unverified**. Bank-grade, enterprise-leaning; low priority.

### OPay (Egypt checkout)
- Docs: https://doc.opaycheckout.com/. Cashier create/status endpoints, sandbox `https://sandboxapi.opaycheckout.com/api/v1/international/cashier/create`, prod `https://api.opaycheckout.com/...`; auth uses public key + merchant ID header (search snippet). Note the doc path is "international"; **unverified** whether Egypt-specific. Everything else **unverified**.

### Others worth knowing
- **Fawaterak:** aggregator, 15+ methods (Visa, Meeza, Vodafone Cash, Orange, Fawry), published 2.75% (https://www.fawaterak.com/blogs/2/ and https://www.linkedin.com/company/fawaterak, search snippets). Technical details **unverified**. Useful as a fallback for small merchants who can't get direct accounts.
- **Paymob Payouts:** separate product for disbursement to wallets/bank (https://payouts.paymobsolutions.com/docs/instant_cashin_api/). Relevant for future marketplace payouts; **unverified** terms.

## Cross-cutting design notes for the adapter
- Amounts: gateways differ (Paymob `amount_cents` integer; Fawry/Kashier use decimal strings with 2dp). Convert integer piastres at the adapter edge only.
- Webhook verification: three styles (SHA-512 HMAC in query, SHA-256 HMAC in header, plain SHA-256 with secret appended). Store raw body, verify before parsing, dedupe on provider transaction id, and never trust the redirect return URL.
- Idempotency: none of the three main gateways showed a request idempotency header in what we could see; use a unique merchant order/reference per attempt (Kashier renewal pattern `REN-{tenant}-{period}-{retry}` is a good model) and a local idempotency table.
- BYO-keys: store merchant gateway keys encrypted per tenant; webhook URL must carry tenant id.
- Sandbox needs a real signup for all gateways; budget a few days for dashboard approvals.

## Recommendation

**Adapter build order:** COD -> InstaPay (manual confirm) -> Paymob -> Kashier -> Fawry -> valU (as a Paymob method, then Geidea/Fawry paths) -> others (Geidea, Fawaterak, PaySky, OPay on demand). The proposed order is sound. One tweak: ship the wallet manual-transfer variant together with InstaPay since it is the same state machine. Paymob before Kashier because one integration covers cards + Meeza + wallets + valU.

**Ebda's own EGP subscription billing:** use **Kashier tokenised recurring** as primary only after Kashier confirms in writing that recurring agreements are enabled on Ebda's account; use **Paymob subscriptions/MIT** as the alternative (documented subscription plan API with TRANSACTION + SUBSCRIPTION webhooks). Run Ebda's own billing engine (invoices, dunning, retries) and treat the gateway as a card-token charger, as the NUMU-IO code does. Fall back to a manual InstaPay invoice link for merchants without cards. Ebda being the merchant of record on its own account avoids the sub-merchant question entirely.

## Open questions for Ahmad
1. Is Ebda willing to hold funds for merchants (payment facilitator model)? That needs a Paymob marketplace / Payouts agreement and a CBE-licensed partner; otherwise BYO-keys only.
2. Who signs up for Ebda's own Paymob and Kashier accounts, and does Whisky 11 have commercial registration + tax card + bank account ready (KYC 3-7 days)?
3. Should the merchant-facing fee be passed through (surcharge) or absorbed? Egyptian rules on card surcharges: **unverified**.
4. Is a single InstaPay manual-confirm acceptable for compliance/fraud tolerance (screenshot fraud)?
5. Do we need Apple Pay (Paymob needs certificates) at launch?
6. Settlement timing: ask Paymob, Kashier, and Fawry sales for current cadence and recurring-agreement enablement in writing.

## Sources
All accessed 2026-10-03 unless noted. "(search)" = seen only in a web-search snippet because the page was blocked.
- Paymob developer hub https://developers.paymob.com/hub/egypt (search)
- Paymob HMAC doc https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback (search)
- Paymob pricing https://paymob.com/en/pricing (search)
- Paymob AI integration skill https://github.com/PaymobAccept/Paymob-AI-Integration-Skill
- Paymob Postman https://github.com/PaymobAccept/API-Postman-Collections
- Paymob subscription example https://github.com/kottaby/kottaby/pull/129 (search)
- Paymob marketplace claim https://www.payselect.ae/providers/paymob (search)
- Kashier pricing https://www.kashier.io/pricing (search)
- Kashier docs https://developers.kashier.io/docs/get-started , /docs/accept-payments/refunds , /docs/accept-payments/payment-sessions , /docs/get-started/going-live , https://developers.kashier.io/payment/webhook/ (search)
- Kashier subscriptions https://www.kashier.io/en/payment-acceptance/subscriptions (search)
- Kashier recurring field evidence https://github.com/NUMU-IO/NUMU-api/pull/678 and https://github.com/NUMU-IO/NUMU-api/pull/681
- Fawry docs https://developer.fawrystaging.com/docs-home (search); Fawry profile https://github.com/api-evangelist/fawry ; Fawry node lib https://github.com/fawry-api/fawry-node (search)
- Geidea https://docs.geidea.net , https://github.com/api-evangelist/geidea , https://docs.geidea.net/docs/valu , https://docs.geidea.net/docs/meeza-qr-apis
- PaySky https://paysky.io/upg/ , https://paysky.io/docs/paysky-omni-gateway-payform-plus-integration-guide/
- OPay https://doc.opaycheckout.com/ (search)
- valU via Amazon Payment Services https://paymentservices.amazon.com/docs/payment-methods/BNPL/valU (search)
- InstaPay https://www.cbe.org.eg/en/payment-systems-and-services/instant-payment-network , https://www.instapay.eg/?page_id=348&lang=en , https://www.lightspark.com/knowledge/egypt-instant-payments (search)
- InstaPay/Vodafone Cash fees https://momocalc.com/egypt/en/instapay-fees , https://momocalc.com/egypt/en/vodafone-cash-fees (search)
- Comparison articles https://www.kerolosxgad.com/writing/payment-gateways-egypt-comparison , https://digitology.co/payment-gateway-egypt/ (search, third-party, undated)
- Fawaterak https://www.fawaterak.com/blogs/2/ (search)
- Paymob Payouts https://payouts.paymobsolutions.com/docs/instant_cashin_api/ (search)
