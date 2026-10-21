---
feature: checkout
updated: 2026-05-24
---

# UAT: Guest Checkout (Kashier)

**Reviewer account:** anonymous (no login required for guest checkout)  
**Admin observer account:** see 1Password vault entry `checkout-uat`  
**Pre-conditions:**

- Test store seeded with ≥1 in-stock product (price > 0)
- Kashier payment provider set to **test mode** on the store (`PAYMENT_TEST_MODE=true` or store-level test flag)
- Fresh browser session (no stored cart, no cookies from previous run)
- Preview/staging env only — **never run against prod**

**Browser matrix:** Chrome latest · Safari latest · mobile Safari iOS 17+

---

## Golden path

1. Navigate to storefront home (e.g. `https://<preview-domain>/`)
2. Verify page loads with correct store name, logo, and at least one product visible
3. Click a product card → product detail page opens in ≤2s
4. Verify product name, price (EGP), images, and "Add to Cart" button are present
5. Click **Add to Cart**
6. Verify cart icon badge increments to 1
7. Open cart (icon or `/cart`) → verify cart item appears with correct name, quantity, price
8. Click **Proceed to Checkout**
9. Fill in shipping form:
   - First name: `UAT`
   - Last name: `Tester`
   - Email: `uat@ebda.app`
   - Phone: `+201000000001`
   - Address: `Block 5, Street 10, Building 3`
   - City: `Cairo`
   - Area: `Maadi` (or any available option)
   - Country: `Egypt`
10. Select **Kashier** payment (or verify it is pre-selected)
11. Click **Place Order** / **Continue to Payment**
12. Kashier test payment page loads within 3s
13. Enter the test card from Kashier's sandbox docs
14. Complete payment
15. Verify redirect back to storefront `/order-confirmation` or `/orders/<id>` page
16. Verify confirmation page shows: order number, item(s), total amount, estimated delivery
17. Verify confirmation email arrives at `uat@ebda.app` within 60s (check store SMTP config)
18. In admin → Orders list: verify new order appears with status `pending` or `paid`
19. Verify order details match: items, quantities, shipping address, payment method

---

## Edge cases

- [ ] **Double submit** — click "Place Order" twice rapidly → only one order created; second click disabled or returns 409; no duplicate charges
- [ ] **Out-of-stock race** — product goes OOS between cart add and checkout submit → checkout returns a clear error message, does not create an unpayable order
- [ ] **Network throttled to slow 3G** (`chrome://inspect` or DevTools) — checkout form still submits within 30s; loading indicator visible throughout
- [ ] **Arabic locale** (switch to AR in language toggle) — RTL layout intact, all form labels in Arabic, error messages in Arabic, confirmation page in Arabic
- [ ] **Cart quantity change** — update quantity to 2 in cart before checkout → order total doubles correctly
- [ ] **COD fallback** (if enabled on store) — select Cash on Delivery → no payment page redirect → order created with `cod` payment method

---

## Known limitations

- Sandbox test cards change periodically — check the provider's sandbox docs if a card is declined
- Inngest order-created fanout (push notification + abandoned-cart sentinels) runs async; allow 30s before checking

---

## Sign-off

| Role         | Name             | Date         | Notes                                      |
| ------------ | ---------------- | ------------ | ------------------------------------------ |
| Engineer     | \***\*\_\_\*\*** | **\_\_\_\_** |                                            |
| Merchant rep | \***\*\_\_\*\*** | **\_\_\_\_** | only required before first merchant launch |
