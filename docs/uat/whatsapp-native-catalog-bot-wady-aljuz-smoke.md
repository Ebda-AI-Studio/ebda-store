# Wady Aljuz native catalog bot — smoke test record

> **Status: TEMPLATE.** Fill in when running Phase E.3 of the WhatsApp Native Catalog Bot cutover. See `docs/runbooks/wady-aljuz-meta-commerce-setup.md` step 10.

## Test setup

- **Date**: YYYY-MM-DD
- **Tester**: Ahmad Sharaf
- **From phone**: Force Media test WhatsApp number `+965XXXXXXXX`
- **To phone**: Wady Aljuz WABA number
- **FWB env**: production
- **WBS env**: production
- **Store.bot_mode before**: `legacy_chat`
- **Store.bot_mode after**: `native_catalog_with_gemini_agent`
- **Sentry release tag**: `<commit-sha>`

## Flow checklist

For each step, capture a WhatsApp screenshot + note the perceived latency (seconds from send to bot reply).

- [ ] **Step 1: "Hi" → bilingual greeting + language buttons**
  - Latency: \_\_\_ s
  - Screenshot: `attachments/01-greeting.png`
  - Issues: none / [describe]

- [ ] **Step 2: Tap "English" → service menu (4 buttons)**
  - Buttons match `Store.bot_service_menu` config: Order Now / Chat with Agent / Locations & Hours / Subscriptions
  - Latency: \_\_\_ s
  - Screenshot: `attachments/02-service-menu.png`

- [ ] **Step 3: Tap "Order Now" → View Catalog button + WhatsApp native catalog opens inline**
  - Native catalog renders products from Meta Commerce
  - Product names, prices, images all present
  - Latency: \_\_\_ s
  - Screenshot: `attachments/03-catalog.png`

- [ ] **Step 4: Add 2 products to cart → tap Checkout**
  - Cart confirmation lists items + prices + total
  - Latency: \_\_\_ s
  - Screenshot: `attachments/04-cart.png`

- [ ] **Step 5: Address pick**
  - First-time customer: bot prompts "Enter new address" with location share / text option
  - Returning: bot lists saved addresses
  - Latency: \_\_\_ s
  - Screenshot: `attachments/05-address.png`

- [ ] **Step 6: Payment method selection (Online vs COD)**
  - Latency: \_\_\_ s
  - Screenshot: `attachments/06-payment.png`

- [ ] **Step 7: Order summary + confirm**
  - Summary shows all 6 fields: items, address, payment method, subtotal, delivery, total
  - Latency: \_\_\_ s
  - Screenshot: `attachments/07-summary.png`

- [ ] **Step 8: Order confirmation message**
  - Order ID, expected delivery window, payment link (if online) OR cash-on-delivery confirmation
  - Latency: \_\_\_ s
  - Screenshot: `attachments/08-confirmation.png`

- [ ] **Step 9: Verify order in FWB admin**
  - Open https://app.forcemediakw.com → Wady Aljuz → Orders
  - New order appears with status `pending` (or `paid` if online payment completed)
  - Customer phone + address match what was submitted in WhatsApp
  - Items match the cart

- [ ] **Step 10: Verify cross-product hand-off**
  - Open https://ws.forcemediakw.com → Conversations
  - The conversation with the test phone shows in the WBS inbox
  - Last message thread shows the order confirmation

## Edge cases to test (after happy path)

- [ ] **Returning customer**: same phone sends "Hi" again — language preference + saved address remembered
- [ ] **Empty cart abandonment**: tap View Catalog, browse, type "stop" or wait 30 min — cart-abandoned reminder fires (see `feedback-multi-step-redis-sentinel-pattern.md`)
- [ ] **Bilingual flip mid-conversation**: send `العربية` after starting in English — bot switches language for next response
- [ ] **Out-of-stock product in catalog**: Meta Commerce shows products marked `availability: 'out of stock'` differently; verify the customer can't add them to cart, OR if they can, the order create rejects with the right error
- [ ] **Order cancellation**: place an order, then send a cancellation request — flows to legacy "chat with agent" branch

## Findings + follow-ups

| Issue                   | Severity | Fix / follow-up |
| ----------------------- | -------- | --------------- |
| _Fill in after running_ |          |                 |

## Sign-off

- [ ] All 10 happy-path steps pass with latency < 3s each
- [ ] At least 3 edge cases tested
- [ ] No P0/P1 Telegram alerts during the test window
- [ ] FWB admin order matches WhatsApp data
- [ ] Wady Aljuz owner has been notified of the cutover via WhatsApp

Once signed-off, the merchant is officially LIVE on the new bot. 24-hour monitor begins.
