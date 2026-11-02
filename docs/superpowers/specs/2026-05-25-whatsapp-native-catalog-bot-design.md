# WhatsApp Native Catalog Bot — Design Spec

> **SUPERSEDED (Ruling WA-LEGACY-1, 2026-10-25):** the Store-side bridge this spec describes was deleted. Historical record only; Ebda Chat (wa.ebda.app) now owns this surface.

**Status**: design approved, ready for implementation plan
**Author**: Ahmad Sharaf + Claude (brainstorming session 2026-05-25)
**Touches**: `ebda-store` (Ebda Store) + `whatsapp-broadcaster` (WBS)
**First merchant**: Wady Aljuz (`demo-merchant.com`)
**Reference UX**: "Platinum Fit" WhatsApp business commerce flow (Meta-recommended pattern)

---

## 1. Goal

Replace the current in-chat product representation (text + image + caption per product) with **Meta Native WhatsApp Catalog**, layered on top of the existing `wa-ordering.js` state machine. Add a structured pre-catalog flow: greeting → language → service menu → catalog → cart → address → payment → confirmation.

Reduce conversation latency from the current ~15s+ per interaction to ≤3s p95.

## 2. Non-goals (out of scope for this spec)

See §11 (Future features) for everything we're deferring.

## 3. User flow (the 8 steps)

```
1. User sends "Hi"
   └─ Bot replies bilingual greeting EN+AR
   └─ Bot sends Interactive Buttons: [English] [عربي]

2. User taps language
   └─ Bot persists locale on wa_carts.context.locale
   └─ Bot sends Interactive List: Services menu (configurable per merchant)
       - 🛒 Order Now
       - 📦 Subscription Boxes  (hidden if merchant has none)
       - 📍 Locations & Hours
       - 💬 Chat with Agent

3. User taps "Order Now"
   └─ Bot sends Interactive Catalog Message with View Catalog CTA
   └─ Reference: Meta Commerce Catalog (synced from Ebda Store store)

4. User browses + adds in Meta Catalog UI
   └─ User taps "Place order" inside catalog
   └─ Meta sends cart-back message to webhook

5. Bot receives cart, summarizes:
   "Subtotal: EGP 1.900"
   Interactive Buttons: [Checkout] [Add More] [Clear Cart]

6. User taps Checkout
   └─ Bot queries Ebda Store /wa-bridge/customer-addresses?phone=...
   └─ If addresses exist → Interactive List of saved addresses
   └─ If none → text-collection sub-flow (Street, Block, Area)
   └─ New address saved via /wa-bridge/customer-addresses/create

7. User picks address
   └─ Bot sends Interactive Buttons: [💳 Online] [💵 Cash]

8. User picks payment method
   └─ Both → bot calls Ebda Store /wa-bridge/cart/from-wa with {address, paymentMethod}
   └─ Ebda Store creates Order
   └─ Cash → bot sends order summary + confirmation (state: completed)
   └─ Online → bot sends payment link from Ebda Store → state: checkout_sent →
              Ebda Store webhook fires on payment success → bot sends confirmation

Alternative branches from step 2:
- "Chat with Agent" → state: agent_chat → routes future inbound to existing
  5-phase Gemini bot. /menu or 30-min idle returns to service menu.
- "Locations & Hours" → one-shot reply from Store.profile.address + .businessHours +
  optional Google Maps link. After reply, return to service menu in 5s.
- "Subscription Boxes" → for Wady Aljuz: "Coming soon" reply. For
  subscription-enabled merchants: separate flow (out of scope here).
```

## 4. Architecture

### 4.1 Service decomposition

```
┌────────────── Ebda Store ──────────────┐         ┌────────────── WBS ──────────────┐
│                                  │         │                                  │
│  Product/Customer/Order writes   │         │  WhatsApp webhook in            │
│         │                        │         │         │                        │
│         ▼                        │         │         ▼                        │
│  Inngest events                  │ Inngest │  wa-ordering.js state machine   │
│  (product.* + customer.*)         │ webhook │         │                        │
│         │                        │         │         ▼                        │
│         ▼                        │         │  wa-interactive.js              │
│  /wa-bridge/* HTTP endpoints     │←HTTP────│  (button/list/catalog builders) │
│   - customer-addresses (NEW)     │         │         │                        │
│   - cart/from-wa (exists)        │         │         ▼                        │
│   - store-catalog (exists)       │         │  metaCatalogService.js (NEW)    │
│   - store/service-menu (NEW)     │         │  (Meta Graph API: catalog ops)  │
│                                  │         │         │                        │
│                                  │         │         ▼                        │
│                                  │         │  Meta Graph API ────────────→ Meta Commerce
│                                  │         │                                  │         Catalog
└──────────────────────────────────┘         └──────────────────────────────────┘
```

### 4.2 State machine

Extends existing `wa_carts.state` enum. Old states preserved (italics = unchanged):

```
                        ┌─ new pre-flow ─┐
                        ▼                │
inbound "Hi" →  awaiting_greeting        │
                        │                │
                        ▼                │
                awaiting_language        │
                        │                │
                        ▼                │
                awaiting_service ────────┘
                        │
        ┌───────────────┼───────────────┬────────────────┐
        ▼               ▼               ▼                ▼
viewing_catalog   agent_chat   locations_replied   subscription_replied
        │                          (5s timer)         (terminal for v1)
        ▼                          back to awaiting_service
cart_received
        │
        ▼
awaiting_more_or_checkout   ← existing state, kept
        │
        ▼
awaiting_address_choice     ← new
        │ (no saved)
        ▼
awaiting_new_address        ← new
        │
        ▼
awaiting_payment            ← new
        │
        ▼
order_summary               ← new (final pre-place confirmation)
        │
        ├─ cash → completed
        └─ online → checkout_sent  ← existing, kept
                        │
                        ▼ (Ebda Store webhook on payment success)
                    completed
```

### 4.3 Data model changes

**Ebda Store `packages/database/prisma/schema.prisma`**:

```prisma
model Store {
  // ... existing fields ...
  bot_mode             String  @default("legacy_chat")
  // enum: legacy_chat | native_catalog | native_catalog_with_gemini_agent
  bot_service_menu     Json?   // { orderNow: bool, subscriptionBoxes: bool,
                                  //   locationsHours: bool, chatWithAgent: bool,
                                  //   labels: { en: {...}, ar: {...} } }
  meta_catalog_id      String? // FB Commerce Catalog ID (per merchant setup)
  meta_business_id     String? // FB Business Manager ID
}

model Customer {
  // ... existing fields ...
  addresses            CustomerAddress[]  // new
  preferred_locale     String?  // 'en' | 'ar' | null
  last_locale_choice   DateTime?  // sticky language: skip picker if <30 days old
}

model CustomerAddress {
  id              String    @id @default(uuid())
  customerId      String
  customer        Customer  @relation(...)
  label           String?   // "Home", "Office" — user-set
  street          String
  block           String?
  area            String
  governorate     String?
  buildingNumber  String?
  notes           String?
  isDefault       Boolean   @default(false)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  @@index([customerId])
}
```

**WBS** (no schema change — `wa_carts` already has `context: Json` for transient state).

### 4.4 New Ebda Store endpoints (added to `apps/api/src/routes/wa-bridge.routes.ts`)

| Endpoint                                            | Purpose                                            |
| --------------------------------------------------- | -------------------------------------------------- |
| `GET /wa-bridge/customer-addresses?phone=`          | List saved addresses for customer (by phone match) |
| `POST /wa-bridge/customer-addresses`                | Create address for customer + return it            |
| `GET /wa-bridge/store/service-menu?storeId=`        | Get this merchant's `bot_service_menu` JSON        |
| `GET /wa-bridge/store/meta-catalog-config?storeId=` | Get `meta_catalog_id` + `meta_business_id`         |
| `POST /wa-bridge/store/meta-catalog-config`         | Set the IDs (called from Ebda Store admin save)    |

### 4.5 New WBS services

| File                                         | Lines target | Purpose                                                                                                                           |
| -------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/services/metaCatalogService.js` | ~200         | Meta Graph API client: `syncProduct(p)`, `deleteProduct(retailerId)`, `getCatalogStatus()`                                        |
| `backend/src/services/wa-interactive.js`     | ~250         | Builder functions: `buildButtons()`, `buildList()`, `buildCatalogMessage()`, `buildAddressMessage()`, `buildProductListMessage()` |
| `backend/src/services/bot-service-router.js` | ~120         | Routes service-menu tap → state branch (Order Now / Agent / Locations / Subscription)                                             |

### 4.6 New WBS Inngest webhook receiver

Ebda Store fires `product.synced.requested` events; WBS exposes `/internal/inngest-receiver` endpoint that calls `metaCatalogService.syncProduct`. Authenticated via shared secret.

## 5. Performance (p50 / p95 budgets)

**Current measured: ~15s+ per round-trip. Unacceptable.** Sources of latency to investigate + design out:

### 5.1 Per-step budgets (target)

| Step                                                      | p50   | p95  | Hard ceiling |
| --------------------------------------------------------- | ----- | ---- | ------------ |
| Webhook inbound → bot reply (no DB write)                 | 500ms | 1s   | 2s           |
| Webhook inbound → bot reply (with Ebda Store bridge call) | 800ms | 2s   | 3s           |
| Catalog open (catalog_message send)                       | 600ms | 1.2s | 2s           |
| Cart received → next message                              | 1s    | 2.5s | 4s           |
| Order finalization (cart/from-wa write)                   | 1.5s  | 3s   | 5s           |
| End-to-end conversation (Hi → completed)                  | 30s   | 90s  | 180s         |

### 5.2 Phase 0 — latency diagnosis (PRE-WORK before Phase A)

Before any feature work, instrument the existing flow:

1. **Pino timing logs** at every span boundary:
   - Webhook accept → message_processed
   - Bridge call start → bridge call return (per endpoint)
   - DB query start → return (per Prisma call)
   - Meta send start → ack
2. **Run a real test** on the WBS-Wady Aljuz stack with verbose logging
3. **Identify top-3 contributors** to current 15s p95:
   - Suspected: Ebda Store API cold start on Railway free tier (5-10s)
   - Suspected: Neon DB cold start (compute pause, 2-5s)
   - Suspected: Sequential bridge calls that could parallelize
   - Suspected: BullMQ queue lag between webhook receipt and processing
4. **Document findings** in `docs/uat/whatsapp-bot-latency-baseline.md`
5. **Quick wins** (apply BEFORE Phase A):
   - Keepalive ping every 4 min to Ebda Store `/health` + Neon (prevent cold start)
   - Parallelize independent bridge calls with `Promise.all`
   - Increase Railway service min instances if free-tier sleep is the cause
   - Move Meta API calls to fire-and-forget where possible (cart-back side-effects)

### 5.3 Design-time latency optimizations

- **Catalog hosted at Meta**: zero round-trip from bot to Ebda Store during browse — Meta serves the catalog UI from their CDN. The user's "View catalog" tap shows the menu instantly. Only the catalog SYNC (background, async) hits Ebda Store.
- **Sticky language**: skip the language picker entirely on second+ conversation within 30 days (read `Customer.preferred_locale`).
- **Pre-warmed Ebda Store**: keepalive ping → no cold start on the bridge calls.
- **Redis cache** for `Store.bot_service_menu` (already exists in WBS, TTL 5 min, invalidated on save).
- **Single bridge call per state transition**: collect all needed data in one `/wa-bridge/<endpoint>` shot; don't make 3 sequential calls.
- **Inngest events for non-blocking work**: analytics logging, customer last-seen update, etc. fire-and-forget via Inngest, NOT inline.

## 6. Migration plan

- New `Store.bot_mode` enum defaults to `legacy_chat` on every existing store. **No automatic cutover.**
- New `bot_mode` admin UI in Ebda Store: a single dropdown on Store → WhatsApp Settings tab.
- Wady Aljuz manually flipped to `native_catalog_with_gemini_agent` only AFTER:
  - Phase A-D shipped
  - Meta Commerce Catalog set up + approved (Meta-side, 24-48h)
  - Smoke test confirms greeting → catalog → cart → order works
- Telegram alert when any merchant first activates `native_catalog*` mode (so we notice early breakage).
- Rollback: flip back to `legacy_chat`; the in-memory `wa_carts` from the new flow are tagged with `context.bot_mode` so they don't bleed into legacy state machine.

## 7. Testing

Per the Ebda AI Studio 5-layer testing standard:

- **Unit**: state machine transitions (every state → every valid next-state), `wa-interactive.js` builders (output validation), `metaCatalogService.js` mocked Meta responses
- **Integration**: full state machine drive (mock webhook inbound → assert correct outbound message + state transition); Ebda Store `/wa-bridge/customer-addresses` endpoint roundtrip
- **E2E**: Playwright not applicable (no UI). Instead, **a "live" smoke** against a Ebda-owned test WhatsApp number that walks the full flow daily via cron.
- **Load**: k6 webhook-burst (100 concurrent inbound → < 5s p95 outbound)
- **UAT**: `docs/uat/whatsapp-native-catalog-bot.md` with golden path + 6 edge cases (no saved address, Online fails, language re-pick, Agent → back to menu, etc.)

## 8. Failure modes

| Failure                                    | Detection                                                        | Behavior                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Meta Catalog API down                      | metaCatalogService 5xx                                           | bot replies "Catalog temporarily unavailable, please try in a few min" + offers Agent path                                        |
| Ebda Store /wa-bridge/\* down              | timeout >3s                                                      | bot replies "I'm having trouble loading your store, please try again" + Telegram alert to merchant                                |
| Cart received but order create fails       | Ebda Store returns error                                         | bot keeps cart in session, replies "There was a problem placing your order. Please tap Checkout again." + Sentry alert            |
| Payment URL never returned to bot (Online) | timer in `checkout_sent`, ping Ebda Store every 5 min for 30 min | if order in `paid` state → send confirmation; else expire to `failed` with "We couldn't confirm payment" + agent escalation offer |
| User types free-form text mid-flow         | state machine doesn't match                                      | reply with bilingual "Please use the buttons below" + re-send current state's interactive                                         |
| User in `agent_chat` types `/menu`         | command match                                                    | exit to `awaiting_service`                                                                                                        |
| Session TTL hit (60 min default)           | `wa-cart-expiry` cron (existing)                                 | mark `expired`, bot replies fresh greeting on next inbound                                                                        |

## 9. Security

- New endpoints `/wa-bridge/customer-addresses` + `/store/*` all use existing `waBridgeAuth` middleware (X-WBS-API-KEY shared secret, already in production)
- Customer phone → customer lookup must verify the request is from the merchant's tenant (storeId scope) — uses existing tenant-context AsyncLocalStorage
- `meta_catalog_id` + `meta_business_id` are NOT secrets; logged at info level OK
- Meta Graph API token (per merchant) stored encrypted on `Store.meta_access_token` via existing `CREDENTIAL_ENCRYPTION_KEY` pattern (like `whatsapp_access_token` already is)

## 10. Estimated effort

Working assumption: one engineer (me + subagents), no parallel work.

| Phase             | Days       | Description                                                                             |
| ----------------- | ---------- | --------------------------------------------------------------------------------------- |
| Phase 0           | 0.5        | Latency diagnosis + quick wins                                                          |
| Phase A           | 1.5        | Catalog sync (Inngest events Ebda Store + metaCatalogService WBS + per-merchant config) |
| Phase B           | 1          | State machine extension + interactive message builders                                  |
| Phase C           | 1.5        | Native Catalog send + cart receive + address book + payment                             |
| Phase D           | 1          | Service menu config + Locations & Hours + Chat with Agent routing + admin UI            |
| Migration + Smoke | 0.5        | Wady Aljuz cutover + smoke test + Telegram observability                                |
| **Total**         | **6 days** | (~1 week)                                                                               |

## 11. Future features (deferred from this spec)

To be tracked here so we don't forget:

### 11.1 Subscription Boxes flow

Real subscription product type in Ebda Store + recurring-billing handler + bot flow for browse + subscribe. Currently `subscription_replied` is a terminal "coming soon" reply.

### 11.2 Agent handoff to live merchant inbox

Current Chat with Agent → routes to 5-phase Gemini bot. Add real live-agent escalation: bot pings merchant (Telegram or WBS admin inbox), merchant takes over conversation, bot watches for `/exit` from merchant to return user to bot.

### 11.3 Voice notes inside the catalog flow

The 5-phase bot supports voice transcription (Phase 3 multimodal). Bring that into the catalog flow so users can say "I want a kg of mastic" and the bot translates that into a catalog add-to-cart.

### 11.4 Order tracking + status via bot

`/track <order-id>` command OR Services menu addition: "Track an Order" → list user's recent orders → tap → status updates. Pulls from Ebda Store `Order.status` history.

### 11.5 Per-merchant catalog image policy

Some merchants want WhatsApp catalog images square 1:1 (Meta default), others want different crops. Add `Store.meta_catalog_image_policy` + auto-process via R2 on sync.

### 11.6 Loyalty + promotions in-chat

When user opens a cart, show "Use 50 points for EGP 0.500 off" inline. Requires Ebda Store loyalty module (not built yet).

### 11.7 Multi-language beyond EN/AR

Spanish, French, etc. for non-Egypt merchants. Current locale is binary; add `Store.supported_locales: string[]` and dynamic language picker.

### 11.8 Bot analytics dashboard

Per-merchant funnel: greeting sent → language picked → service tapped → catalog opened → cart placed → order created. Already capturing via `botAnalytics`; need Ebda Store admin dashboard to surface.

### 11.9 Re-engagement flow

For abandoned carts (`wa_carts.state = checkout_sent` + no payment after 30 min): bot sends a polite nudge with a "Complete your order" deep-link.

### 11.10 Server-driven UI updates

When Meta releases new interactive message types (flows, forms, etc.), abstract behind `wa-interactive.js` so the state machine doesn't care about Meta's message format changes.

### 11.11 A/B test framework

Per-store: test which service menu layout converts best (2 button vs list vs catalog-first). Pipe results to Ebda Store analytics.

### 11.12 Group chat support

Currently 1:1 only. Some merchants run WhatsApp Group orders. Out of scope for v1, requires major state-machine rework.

---

## Self-review notes

**Placeholders / TBDs**: none — every section is concrete.

**Scope check**: 6-day effort across 4 phases. Each phase ships independently. Ready for a single writing-plans pass (one plan with 4 task groups).

**Ambiguity check**:

- "Chat with Agent" v1 = Gemini bot (legacy 5-phase). Real live-agent escalation in §11.2.
- "Native Catalog" requires Meta Commerce setup; design assumes Wady Aljuz completes Meta-side setup in parallel with our build.
- Sticky language window: 30 days (chosen, not negotiable in this spec).

**Decisions locked**:

- Native Catalog (not in-chat lists)
- Gemini kept for Agent path
- Real-time product sync (not batch)
- Ebda Store customer record for addresses (not separate WBS store)
- All 4 service menu items, configurable per merchant
- Wady Aljuz first
