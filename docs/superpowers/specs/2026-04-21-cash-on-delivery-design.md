# Cash on Delivery (COD) Payment Method

## Overview

Add COD as an opt-in payment method that store owners configure from payment settings with an optional surcharge fee. Admins mark orders as paid individually or in bulk when cash is collected.

## Data Model

No new models. Uses existing `PaymentConfig` with `provider: 'cod'`:

- `provider: 'cod'` added to `PaymentProvider` enum in schema + types
- `fixedFee`: surcharge in fils (e.g., 500 = 0.500 KWD), 0 for free COD
- `isEnabled`: toggle per store
- Credential fields (`apiKey`, `secretKey`, etc.) stay null — no validation required for COD

Feature toggle: `StoreFeature` with `featureKey: 'cod'`

## API Changes

### Payment creation (existing endpoint)

`POST /payments/create` — when `provider === 'cod'`:

- Create Payment record with `status: 'cod_pending'`, no `paymentUrl`
- Add COD fee to order total if configured
- Return `{ success: true, data: { provider: 'cod', cod: true } }` (no paymentUrl)

### Mark as paid (new endpoints)

`POST /stores/:storeId/orders/:orderId/mark-paid`

- Auth: `authenticate` + `authorize('store_admin', 'super_admin')` + `requireStoreAccess`
- Validates order is COD and `paymentStatus !== 'paid'`
- Updates: `paymentStatus: 'paid'`, `status: 'confirmed'`, Payment `status: 'completed'`, `paidAt: now()`
- Sends customer notification via dispatcher

`POST /stores/:storeId/orders/bulk-mark-paid`

- Auth: same as above
- Body: `{ orderIds: string[] }` (max 50)
- Validates all orders belong to store, are COD, and unpaid
- Updates all atomically in a transaction
- Returns count of updated orders

### Payment config (existing endpoint)

`POST /payment-settings/store/:storeId` — allow `provider: 'cod'` without credential validation. Only `fixedFee` and display names required.

### Payment config response

`GET /payments/config` — include COD in available providers list when enabled, with fee amount.

## Frontend Changes

### Storefront checkout (`CheckoutClient.tsx`)

- Fetch COD config from `/payments/config` response
- Show "Cash on Delivery" radio option with fee displayed (e.g., "+0.500 KWD")
- When COD selected: add fee to displayed total
- On submit with COD: create order, create payment with provider='cod', skip gateway, redirect to success
- Success page: show "Pay cash on delivery" message instead of "Payment confirmed"

### Admin payment settings (`payment-settings/page.tsx`)

- Show COD card alongside other providers
- Config form: enable/disable toggle, display name (EN/AR), surcharge fee input
- No API key/secret fields for COD

### Admin orders list (`orders/page.tsx`)

- "Awaiting Cash" badge for COD orders with `paymentStatus !== 'paid'`
- Bulk checkbox selection + "Mark as Paid" bulk action button
- Button only visible when COD orders are selected

### Admin order detail (`orders/[orderId]/page.tsx`)

- "Mark as Paid" button for unpaid COD orders
- Confirmation modal: "Confirm cash payment of X KWD received?"
- After confirmation: badge updates to "Paid", button disappears

## Verification

1. Enable COD for a store via payment settings with 0.500 KWD fee
2. Checkout as customer, select COD, verify fee added to total
3. Complete order — verify redirects to success with COD message
4. Admin orders list shows "Awaiting Cash" badge
5. Mark single order as paid — verify status updates
6. Create 3 COD orders, bulk mark as paid — verify all update
7. Verify non-COD orders don't show mark-as-paid controls
8. Verify store without COD enabled doesn't show COD option at checkout
9. Run existing test suite — no regressions
