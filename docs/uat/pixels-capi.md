# UAT — Server-Side Conversions (Meta CAPI + TikTok Events API)

**Feature branch:** `feat/pixels-server-side-capi`
**Scope:** Purchase conversion events sent server-to-server on every confirmed order,
independent of the browser pixel.

---

## Prerequisites

- A store with the `marketing_pixels` feature enabled.
- A Meta pixel with a live **Conversions API access token** configured in
  **Admin → Marketing Pixels → Meta**.
- (Optional) A TikTok pixel with an access token for TikTok Events API.
- Access to **Meta Events Manager → Test Events** for your pixel.
- Access to the **Inngest dashboard** or Railway logs to observe function execution.

---

## Golden path — Meta CAPI

### Step 1 — Enter a test event code

1. Open **Meta Events Manager → Test Events** for your pixel.
2. Copy the `TEST_EVENT_CODE` value shown there (e.g. `TEST12345`).
3. In **Admin → Marketing Pixels → Meta**, paste that code into the
   **Test event code** field. Save.

### Step 2 — Place a test order

1. Open the storefront in a browser **with an ad-blocker enabled** (e.g. uBlock Origin).
   This ensures the browser pixel is blocked so only the server event fires.
2. Add a product to cart, proceed to checkout, complete a payment (COD is fine for testing).
3. Confirm you land on the `/checkout/success?orderId=<uuid>` page.

### Step 3 — Verify in Meta Events Manager

1. Open **Meta Events Manager → Test Events**.
2. Within ~10 seconds you should see a **Purchase** event appear under
   **Server** (not Browser — because the browser pixel was blocked).
3. Verify:
   - `event_name` = `Purchase`
   - `action_source` = `website`
   - `custom_data.currency` = `KWD`
   - `custom_data.value` = total ÷ 1000 (e.g. KWD 5.500 appears as `5.5`)
   - `user_data` shows match quality indicators (email / phone — hashed)
   - `event_id` = the order UUID

### Step 4 — Deduplication check

1. Reload the success page in a browser **without** the ad-blocker.
   This fires the browser-side `fbq('track','Purchase',…,{eventID:<orderId>})`.
2. In Meta Events Manager → Test Events you should still see **exactly one
   Purchase event** for this order (Meta deduplicates on `event_id`).

---

## Golden path — TikTok Events API

1. Enter a TikTok access token in **Admin → Marketing Pixels → TikTok → Access Token**.
2. Place a test order.
3. In **TikTok Ads Manager → Events → Web Events**, verify a `CompletePayment`
   event appeared with the correct `event_id` (order UUID) and `value`.

---

## Edge cases

| Scenario                                           | Expected behaviour                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Store has pixel enabled but no access token        | No CAPI call; browser pixel fires normally                                   |
| Access token shows `****` in admin (mask sentinel) | Server treats this as "token not configured" — no CAPI call                  |
| CAPI endpoint returns HTTP 500                     | Error logged to Railway logs; order flow unaffected; Inngest retries once    |
| `marketing_pixels` feature disabled for the store  | Inngest function exits early with `skipped: feature_disabled`; no HTTP calls |
| COD order                                          | CAPI fires immediately on `order/created` (same as paid online orders)       |
| Guest checkout (no customer account)               | Email + phone read from `shippingAddress`, hashed, sent in `user_data`       |

---

## Verifying in Inngest

1. Open the **Inngest dashboard** (dev: `http://localhost:8288`; prod: Inngest cloud).
2. Under **Functions**, find `order-capi-conversion`.
3. After placing an order, a run should appear with status **Completed**.
4. Inspect the `send-capi` step — it should show `sent: true`.

---

## Verifying in Railway logs

Look for these structured log lines after an order is placed:

```
[pixels-capi] meta purchase event sent   { orderId, pixelId, eventsReceived: 1 }
[pixels-capi] tiktok purchase event sent { orderId, pixelId }
```

If CAPI fails:

```
[pixels-capi] meta capi send failed — failing open   { err, orderId, pixelId }
```

---

## Not testable without a live token

The unit tests (`tests/unit/pixels-capi.test.ts`) verify:

- SHA-256 hashing of email (lowercase + trim) and phone (digits + E.164)
- Correct request shape (event_id = orderId, value ÷ 1000, currency, hashed PII)
- test_event_code passthrough
- Skip behaviour (disabled, no token, masked token)
- Fail-open: HTTP 500 and TikTok error-code responses do not throw

End-to-end verification against the real Meta/TikTok API requires a live
CAPI token — use the **Test event code** path above to confirm delivery.
