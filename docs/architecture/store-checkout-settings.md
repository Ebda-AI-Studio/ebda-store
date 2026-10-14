# Per-store checkout & order settings (`Store.settings` JSON)

Opt-in, per-store checkout/order behaviours. All live in the `Store.settings` JSON
column (typed as `StoreSettings` in `@ebda/shared`) — **no dedicated DB columns, no
migrations**. Every one is platform-level (any store can enable it, never hardcoded to a
slug). Merchant-editable at **Store → Settings → Delivery**
(`apps/admin/src/app/stores/[id]/delivery/page.tsx`). Unset/empty = feature off.

## `orderInvoiceEmail?: string`

When set to a valid email, every order placed in the store auto-emails the rendered PDF
invoice to that address (e.g. the store owner). Fires from the `order/created` fanout
(`apps/api/src/lib/inngest/functions/order-created.ts`, `send-owner-invoice` step →
reuses the existing `order/invoice.email-requested` pipeline). Resolver:
`resolveOrderInvoiceRecipient` (same file). Empty/unset = no owner invoice sent.

## `minimumOrderFils?: number`

Minimum items **subtotal** (in fils; 1 KWD = 1000 fils) required to place an order.
`0`/unset = no minimum. Enforced in three places (shared helper `checkMinimumOrder` in
`packages/shared/src/utils/minimum-order.ts`):

- **Server (the real guard):** `OrderService.create` throws `AppError(400,
'MINIMUM_ORDER_NOT_MET', …)` — applies to the customer/storefront path, not admin manual
  orders.
- **Cart:** `apps/web/.../cart/CartClient.tsx` disables "Proceed to checkout" + shows an
  "add X more" message below the minimum.
- **Checkout:** `CheckoutClient.tsx` blocks the Pay button + maps the `MINIMUM_ORDER_NOT_MET`
  API code to the same friendly message.

## `checkoutDelivery?: { note, windows }`

A delivery block shown on the storefront checkout **immediately above the Pay button**
(`apps/web/.../checkout/_components/DeliverySection.tsx`, wired in `CheckoutClient.tsx`).

### `note: { enabled: boolean, text: string, textAr: string }`

A merchant-written info note (EN/AR), shown per the customer's locale when `enabled`.

### `windows: { enabled: boolean, items: DeliveryWindow[] }`

A delivery-window selector; the customer picks one and it's saved onto the order `notes`
(`"Delivery: Today|Tomorrow, <label> (<start>–<end>)"`).

`DeliveryWindow = { id, label, labelAr, start, end, orderBy? }` — times are `"HH:mm"` 24h.

- **`orderBy?`** — the last store-local time a customer can still pick this window today.
  Falls back to `start` when unset. A window disappears once the store-local time (store
  `timezone`, default `Asia/Kuwait`) passes its `orderBy`.
- **Next-day rollover:** once **all** of today's windows have passed their `orderBy`, the
  selector rolls over to **Tomorrow** (all windows selectable again, "Tomorrow" badge).

Availability logic is the pure, unit-tested `resolveDeliverySelection(items, nowMinutes)`
in `apps/web/.../checkout/_lib/deliveryWindows.ts` (`getNowMinutesInTimezone` derives the
store-local minutes). Example — window A order-by 14:00, window B order-by 19:00: at 13:59
both available (today); 14:01 only B; 18:59 only B; 19:01 → tomorrow, both.

## Editing / adding a setting

The admin delivery page reads the full `settings` object and re-saves it via
`PUT /api/v1/stores/:id` (`StoreService.update` server-side shallow-merges `settings`).
When adding a new key here, add it to the `StoreSettings` type in
`packages/shared/src/types/index.ts` **and** its `.d.ts` mirror.
