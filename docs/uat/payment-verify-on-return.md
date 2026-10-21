---
feature: payment-verify-on-return
updated: 2026-06-09
---

# UAT: Verify-on-return payment confirmation

The reliable primary path that confirms an online payment the moment the
customer returns to the checkout-success page — independent of the
account-level MyFatoorah webhook (which doesn't fire per-invoice for Ebda Store).

**Reviewer account:** anonymous (guest checkout — no login)
**Admin observer account:** see 1Password vault entry `checkout-uat`
**Pre-conditions:**

- Test store with MyFatoorah in **test mode** + ≥1 in-stock product (price > 0)
- `ONESIGNAL_ADMIN_APP_ID` / `ONESIGNAL_ADMIN_REST_API_KEY` (or public fallback)
  and `RESEND_API_KEY` set in the preview API env so the fanout can deliver
- Preview/staging env only — **never run against prod**

**Endpoint under test:** `POST /api/v1/public/orders/:id/verify-payment`

---

## Golden path — paid

1. Guest-checkout a test order, choose MyFatoorah, complete payment with a
   test card on MyFatoorah's hosted page.
2. On return, the success page shows the **green check** + "Thank you for your
   order!" / "Your payment is confirmed…" — NOT a spinner that hangs.
3. The Order in admin (`/stores/:id/orders`) shows `payment_status = paid`,
   `status = confirmed` within seconds.
4. The admin receives the **OneSignal "new order" push** + the order-confirmation
   **email** fires (check Resend logs). WhatsApp notify if configured.
5. `payment_events` has BOTH a `created` row AND a `reconciliation` row
   (`details.source = 'guest_verify'`, `toStatus = completed`).

## Idempotency

6. Reload the success page (or hit the endpoint again). Order stays `paid`,
   NO second push/email, NO duplicate `order/created` — only the first
   transition fans out. The endpoint returns `statusChanged: false`.
7. If the provider webhook IS also configured, it landing after the verify is
   likewise a no-op (no double-send).

## Pending / failed

8. Start a payment but cancel on the gateway, then land on the success URL with
   the orderId: the page shows the **amber spinner** → "Confirming your
   payment…" or the **red X** → "Payment not completed" with a **Try payment
   again** button. It must NOT falsely claim "confirmed".
9. Order stays `unpaid` (pending) or flips to `failed`; no "new order" push.

## IDOR / authz

10. Call `POST /public/orders/<random-uuid>/verify-payment` → `404`.
11. Call verify for an order owned by a signed-in customer while NOT signed in
    as them → `403`.
12. Even with a valid guest orderId, the order only flips to paid when
    MyFatoorah's GetPaymentStatus independently reports that invoice **Paid** —
    a caller cannot fabricate "paid".

## Admin Refresh parity

13. On an unpaid order whose webhook was missed, click **Refresh payment** in
    admin → same outcome as verify-on-return (paid + fanout once), because both
    call the shared `confirmPaymentFromProviderStatus` routine.
