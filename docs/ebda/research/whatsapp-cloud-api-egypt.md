# WhatsApp Cloud API for Ebda: Egypt pricing and platform notes

Researched: 2026-10-03

**Verification caveat:** Meta's own pricing pages (developers.facebook.com) and BSP pages were blocked by the research sandbox's egress proxy. Figures below come from WebSearch summaries of Meta's documentation and of BSP/aggregator pages. Egypt rates conflict between aggregators, so every Egypt rate is marked **unverified** until checked against Meta's downloadable rate card (Meta Business Manager > Billing, or the CSV linked from [Meta pricing docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)).

## Answer

Meta bills the WhatsApp Business Platform per delivered message (since 2025-07-01), not per 24-hour conversation, priced by recipient country and category: marketing, utility, authentication, and (new from 2026-10-01) service. Per search summaries of Meta's notice, since 2026-10-01 service messages and utility templates sent inside the 24-hour customer-service window are no longer free: service messages are free only for the first 1,000 per business phone number per month, then billed at the country's utility rate; messages within the 72-hour free-entry-point window (click-to-WhatsApp ads, Facebook page CTA) stay free. For Egypt, the most consistently reported Meta rates (effective 2026-07-01) are marketing $0.0644, utility $0.0036, authentication $0.0036 per message, excluding 14% VAT, though another source lists higher figures, so treat all as **unverified**. Ebda should ship a free wa.me click-to-chat tier first (no API, no cost) and later sell a metered "Ebda Chat platform" tier that passes Meta's per-message cost through at cost plus a small disclosed platform margin.

## Decision table

| Decision               | Recommendation                                                                                 | Basis                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Free tier              | wa.me click-to-chat with prefilled order text                                                  | No API needed; zero Meta cost                                 |
| Paid tier connectivity | Ebda as a Tech Provider/BSP-style layer over Cloud API, each merchant on their own WABA        | Cloud API is the only infrastructure; BSPs add tooling        |
| Meta cost pass-through | Bill actual Meta per-message charges by category and country, no hidden markup on Meta portion | Meta rate is identical across BSPs; only platform fee differs |
| Ebda margin            | Separate, visible platform fee (flat monthly and/or small per-message)                         | Keeps pricing legible; Ahmad sets numbers                     |
| Service messages       | Meter after 1,000 free per number per month                                                    | Oct 2026 rule                                                 |
| Marketing messages     | Prepaid credit/wallet only, opt-in required                                                    | Highest per-message cost (about 18x utility)                  |
| Verification           | Require merchant Meta Business verification before enabling API                                | Needed for limits and features                                |

## Current pricing model (as of 2026-10-03)

- Per-message pricing replaced per-conversation pricing on 2025-07-01. Source: [Chatmaxima Egypt](https://chatmaxima.com/whatsapp-api-pricing/egypt/), [Blueticks](https://blueticks.co/blog/whatsapp-business-api-pricing-2026) (search summaries, 2026-10-03).
- Charged categories: marketing (every delivered template), utility, authentication; and from 2026-10-01 service messages. Source: [Meta pricing docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), [Meta non-template messages notice](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages) (search summaries; pages not directly readable).
- 2026-10-01 changes (per [360dialog](https://360dialog.com/blog/whatsapp-service-message-charging-october-2026/), [respond.io](https://respond.io/blog/whatsapp-pricing-change-2026), [Pickyassist](https://pickyassist.com/blog/whatsapp-pricing-changes-october-2026/), all search summaries 2026-10-03):
  - Service (non-template) messages: billed per message at the country's utility rate, after 1,000 free per business phone number per month (no rollover, resets monthly).
  - Utility templates sent inside an open service window, free since 2025-07-01, are now charged.
  - Free entry points (72-hour window) and the WhatsApp Business App remain free.
  - No volume tiers on service messages.
  - 40 rates updated; Egypt, Morocco, Saudi, UAE and others had marketing increases; Egypt not named in the increase lists seen, **unverified**.
- Billing currency is USD for the Egypt rate card; Egyptian 14% VAT is reported as added on top. Source: [Chatmaxima Egypt](https://chatmaxima.com/whatsapp-api-pricing/egypt/) (2026-10-03).

## Egypt rates per category

| Category       | Rate USD per message (most-cited)                    | EGP at 52.24               | Conflicting figure                                                                                                                                                         | Status                                                    |
| -------------- | ---------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Marketing      | 0.0644                                               | about 3.36                 | 0.0694 ([flowcall](https://www.flowcall.co/blog/whatsapp-business-api-pricing)); 0.1073 ([Ominiflow](https://ominiflow.com/whatsapp-api-pricing/egypt), likely older rate) | **unverified**                                            |
| Utility        | 0.0036                                               | about 0.19                 | 0.0086 (same conflicting source)                                                                                                                                           | **unverified**                                            |
| Authentication | 0.0036                                               | about 0.19                 | 0.0086; international-authentication 0.070                                                                                                                                 | **unverified**                                            |
| Service        | free for first 1,000/number/month, then utility rate | about 0.19 after allowance | n/a                                                                                                                                                                        | rule per Meta notice summaries; Egypt rate **unverified** |

- The 0.0644/0.0036/0.0036 set is reported as "effective July 1, 2026, from Meta's official USD rate card" by [Chatmaxima](https://chatmaxima.com/whatsapp-api-pricing/egypt/) and [ArabyBot](https://arabybot.com/guides/whatsapp-api-pricing-egypt?lang=en) (search summaries). I could not confirm it against Meta's CSV, and the Oct 2026 refresh may have changed it. Do not hard-code until verified.
- FX: 1 USD = 52.24 EGP, mid-market 2026-10-03 ([Wise](https://wise.com/gb/currency-converter/usd-to-egp-rate)).
- Meta bills in USD; Egyptian merchants paying by EGP card will also carry FX spread. This matters for pass-through (see recommendation).

## Free allowances

| Allowance                        | Detail                                                                                                                                                                               | Source                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Customer service window          | 24 hours after the customer's last message; free-form replies allowed. Since 2026-10-01 not free by default: first 1,000 service messages/phone number/month free, then utility rate | [360dialog](https://360dialog.com/blog/whatsapp-service-message-charging-october-2026/), [Sendpulse](https://sendpulse.com/blog/whatsapp-service-message-pricing) (2026-10-03) |
| Free entry points                | Click-to-WhatsApp ads and Facebook Page CTA open a 72-hour window; replies in that window are free                                                                                   | [respond.io](https://respond.io/blog/whatsapp-pricing-change-2026) (2026-10-03)                                                                                                |
| WhatsApp Business App            | Free; manual use, not API                                                                                                                                                            | same                                                                                                                                                                           |
| Utility templates in open window | Free 2025-07-01 to 2026-09-30; charged from 2026-10-01                                                                                                                               | [Pickyassist](https://pickyassist.com/blog/whatsapp-pricing-changes-october-2026/)                                                                                             |

## Volume tiers

- Volume discounts apply to utility and authentication categories only (tiered by monthly volume per business account/WABA) per [Chatmaxima](https://chatmaxima.com/whatsapp-api-pricing/egypt/); marketing tiering and the Egypt tier thresholds/discount percentages are **unverified**.
- Service messages: no volume tiers ([wawcd](https://wawcd.com/blog/whatsapp-pricing-change-october-2026)).
- Implication: small Egyptian merchants will rarely hit discounts; Ebda aggregating many merchants under one WABA would not necessarily pool volume, since tiers are per WABA, **unverified** whether per-merchant or per-partner counting applies.

## Direct Cloud API vs BSP

- Cloud API is Meta-hosted and is the underlying infrastructure either way; a BSP sits on top adding onboarding, template tooling, inbox, support. Source: [Intellicon](https://www.intellicon.io/whatsapp-cloud-api-vs-bsp/), [Emovur](https://emovur.com/blog/whatsapp-business-api/whatsapp-bsp-vs-meta-cloud-api-which-to-choose) (search summaries).
- Meta's per-message rate is identical across providers; BSPs differ in platform fee ([Chatmaxima](https://chatmaxima.com/whatsapp-api-pricing/egypt/)). BSPs commonly active in Egypt: Twilio, Bird (MessageBird), 360dialog, Vonage, Unifonic ([Quali-D](https://quali-d.com/blog/whatsapp-api-egypt-guide)).
- Ebda options: (a) direct Cloud API as a Tech Provider with Embedded Signup so each merchant owns their WABA and Meta bills the merchant or Ebda per setup (billing arrangement **unverified**); (b) resell via a BSP (faster, adds markup, less control). Eligibility for Tech Provider/Solution Partner status and credit-line billing terms: **unverified**; confirm in Meta's partner docs.

## Business verification and display name

- Needs a Meta Business Manager/Portfolio; Meta business verification (legal name, commercial registration or tax docs, website/domain, business email/phone) unlocks higher messaging limits and features. Source: [Quali-D Egypt guide](https://quali-d.com/blog/whatsapp-api-egypt-guide), [Infobip](https://www.infobip.com/docs/whatsapp/get-started/business-verification) (search summaries).
- Display name must represent the business and match its website/brand; rejected if a personal full name, generic term, generic location, slogan or long description; at least 3 characters. Source: [AiSensy](https://m.aisensy.com/blog/display-name-for-whatsapp-business-api/).
- Typical timeline claimed: 3-5 business days end to end (Meta approval 1-2 days, display name 1-2 days) per [Quali-D](https://quali-d.com/blog/whatsapp-api-egypt-guide); treat as marketing estimate, **unverified**.
- Product implication: many Egyptian micro-merchants (Instagram/Facebook sellers) lack a commercial registry; verification may block them, which is another reason the wa.me tier must be good on its own.
- Messaging-limit tiers and quality rating rules: **unverified** here.

## What wa.me click-to-chat can and cannot do

| Can                                                                                        | Cannot                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Open a chat with the merchant's number and prefill text (e.g. order summary, product link) | Send anything automatically; nothing is delivered until the customer presses send     |
| Work on mobile and desktop, zero cost, no verification                                     | Receive webhooks, track clicks-to-sent, delivery or read status                       |
| Be shown as a button on product, cart and thank-you pages                                  | Send order confirmations, shipping updates, abandoned-cart or marketing messages      |
| Carry URL-encoded text (order id, items, total)                                            | Manage templates, broadcast, or run bots; prefill is visible and editable by customer |
| Be used by the merchant on the free WhatsApp Business App (free)                           | Provide server-side audit trail or reliable attribution                               |

Source: [Qualimero](https://qualimero.com/en/blog/whatsapp-link), [Unipile](https://www.unipile.com/api-whatsapp-link/), [Quadlayers](https://quadlayers.com/how-to-create-a-whatsapp-link-wa-me-with-a-pre-filled-message/) (search summaries, 2026-10-03). Implementation note: URL-encode text or it truncates at the first space.

## Recommendation: what the paid "Ebda Chat platform" tier should pass through

1. Pass through Meta's per-message charge by category and country at actual rate, shown on an itemised usage statement; no markup on the Meta portion (competitive norm per Chatmaxima). Ebda earns via a separate platform fee (monthly subscription add-on and/or per-message fee), numbers to be set by Ahmad.
2. Prepaid EGP wallet: merchants top up in EGP; Ebda holds USD exposure. Add an FX buffer or reprice the wallet rate periodically, since Meta bills USD and EGP moved within about 1% over 7 days but has been volatile historically. Disclose that VAT (14%) applies.
3. Meter by category: marketing sends deduct from wallet at the marketing rate (about 18x utility at the cited figures); utility/authentication at their rate; service messages free for the first 1,000 per number per month then utility rate. Hard-stop marketing when the wallet is empty; never silently drop order-confirmation utility messages.
4. Include in plan entitlements a monthly allowance of free-to-the-merchant messages only if Ebda is willing to absorb the cost; at the cited Egypt utility rate about $0.0036, 1,000 messages is about $3.60 (about EGP 190) before VAT, so a modest allowance is cheap, but marketing is not (1,000 marketing messages about $64, about EGP 3,360).
5. Gate API tier on completed business verification and display-name approval; keep wa.me as the always-on fallback.
6. Re-pull Meta's CSV rate card each quarter (rates changed on 2026-01-01, 2026-07-01 and 2026-10-01 per sources) and store rates in a versioned table, not code.

## Open questions for Ahmad

1. Who should hold the WABA: merchant (Embedded Signup) or Ebda? This decides who Meta bills and how much margin Ebda can take.
2. Tech Provider vs resell via a BSP (Twilio, 360dialog, Bird, Unifonic)? Needs a partner-terms review.
3. Absorb a free utility allowance in plans, or fully metered?
4. Is marketing broadcast in scope for launch, given opt-in and compliance burden?
5. Charge the platform fee flat per month, per message, or both?
6. Egypt rates: someone with Meta Business Manager access must download the current rate card CSV to settle the 0.0644/0.0036 vs 0.0694/0.0086 conflict.
7. Do merchants without commercial registration need an alternative path (wa.me only, or an unofficial route, which we should not offer)?

## Sources (accessed 2026-10-03, via search summaries; direct fetch blocked)

- [Meta: Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [Meta: pricing updates for service and utility messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages)
- [Chatmaxima: Egypt rates](https://chatmaxima.com/whatsapp-api-pricing/egypt/)
- [ArabyBot: Egypt pricing](https://arabybot.com/guides/whatsapp-api-pricing-egypt?lang=en)
- [Flowcall: rates by country Oct 2026](https://www.flowcall.co/blog/whatsapp-business-api-pricing)
- [Ominiflow: Egypt](https://ominiflow.com/whatsapp-api-pricing/egypt)
- [360dialog: service message charging](https://360dialog.com/blog/whatsapp-service-message-charging-october-2026/)
- [respond.io: pricing change 2026](https://respond.io/blog/whatsapp-pricing-change-2026)
- [Pickyassist: Oct 2026 changes](https://pickyassist.com/blog/whatsapp-pricing-changes-october-2026/)
- [Sendpulse: service message pricing](https://sendpulse.com/blog/whatsapp-service-message-pricing)
- [wawcd: Oct 2026 change](https://wawcd.com/blog/whatsapp-pricing-change-october-2026)
- [Blueticks: pricing 2026](https://blueticks.co/blog/whatsapp-business-api-pricing-2026)
- [Quali-D: WhatsApp API in Egypt](https://quali-d.com/blog/whatsapp-api-egypt-guide)
- [Infobip: business verification](https://www.infobip.com/docs/whatsapp/get-started/business-verification)
- [AiSensy: display name](https://m.aisensy.com/blog/display-name-for-whatsapp-business-api/)
- [Intellicon: Cloud API vs BSP](https://www.intellicon.io/whatsapp-cloud-api-vs-bsp/)
- [Emovur: BSP vs Cloud API](https://emovur.com/blog/whatsapp-business-api/whatsapp-bsp-vs-meta-cloud-api-which-to-choose)
- [Qualimero: WhatsApp links](https://qualimero.com/en/blog/whatsapp-link)
- [Unipile: wa.me explained](https://www.unipile.com/api-whatsapp-link/)
- [Quadlayers: wa.me prefilled](https://quadlayers.com/how-to-create-a-whatsapp-link-wa-me-with-a-pre-filled-message/)
- [Wise USD/EGP](https://wise.com/gb/currency-converter/usd-to-egp-rate)
