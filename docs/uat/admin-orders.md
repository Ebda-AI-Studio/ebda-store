---
feature: admin-orders
updated: 2026-05-24
---

# UAT: Admin Order Management

**Reviewer account:** see 1Password vault entry `admin-orders-uat`  
(store_admin role on the test store; email/password in vault)  
**Pre-conditions:**

- At least 3 test orders exist (placed via checkout UAT or seeded)
- At least 1 order in `pending` status (simulates just-placed COD order)
- At least 1 order in `paid` status (simulates completed online payment)
- Preview/staging env; admin at `https://<preview-admin-domain>/`

**Browser matrix:** Chrome latest · Safari latest · mobile Safari iOS 17+

---

## Golden path

1. Navigate to admin login page → sign in with test credentials
2. Verify redirect to dashboard within 2s
3. Click **Orders** in the sidebar
4. Verify orders list loads with columns: Order #, Customer, Total, Status, Date
5. Verify DateRangePicker defaults to a sensible window (last 30d or current month)
6. Click on a `pending` order row → order detail page opens
7. Verify order detail shows: line items, quantities, unit prices, subtotal, shipping, total
8. Verify customer shipping address block is present and complete
9. Verify payment method shown (`cod` or `myfatoorah`)
10. Click **Mark as Paid** → confirm dialog → status changes to `paid` within 2s (optimistic update)
11. Verify status chip on detail page updates; navigate back to list → order shows `paid`
12. Open a `paid` order → verify **Refund** button is present
13. Click **Refund** → enter amount → confirm → status changes to `refunded` or `partially_refunded`
14. Open any order → find **Shipping Carrier** section → type carrier name (`Aramex`) + tracking number (`1234567890`) → click Save
15. Verify carrier + tracking saved (refresh page; values persist)
16. Verify customer receives shipping update notification (push or email) within 60s if enabled

---

## Edge cases

- [ ] **Filter by status** — use status dropdown to filter `pending` only → list shows only pending orders; URL query param updates (for shareable filter links)
- [ ] **Search by order number** — type partial order number in search box → matching order appears within 500ms
- [ ] **Mark paid twice** — click "Mark as Paid" on an already-paid order → button is disabled or returns a clear "already paid" error; no double state change
- [ ] **Refund more than order total** — attempt to refund KWD 9999 on a KWD 5 order → validation error shown inline, no API call sent
- [ ] **Large order list pagination** — if >50 orders exist, verify pagination/cursor works; page 2 loads distinct orders
- [ ] **Arabic locale** — switch admin locale to AR → RTL layout; order status chips and column headers in Arabic

---

## Sign-off

| Role         | Name         | Date         | Notes                                      |
| ------------ | ------------ | ------------ | ------------------------------------------ |
| Engineer     | ****\_\_**** | **\_\_\_\_** |                                            |
| Merchant rep | ****\_\_**** | **\_\_\_\_** | only required before first merchant launch |
