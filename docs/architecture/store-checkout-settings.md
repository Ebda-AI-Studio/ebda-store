# Per-store checkout & order settings (`Store.settings` JSON)

Opt-in, per-store checkout/order behaviours. All live in the `Store.settings` JSON
column (typed as `StoreSettings` in `@ebda/shared`) — **no dedicated DB columns, no
migrations**. Every one is platform-level (any store can enable it, never hardcoded to a
slug). Merchant-editable at **Store → Settings → Delivery**
(`apps/admin/src/app/stores/[id]/delivery/page.tsx`). Unset/empty = feature off.

## `orderInvoiceEmail?: string`

When set to a valid email, every order placed in the store auto-emails the rendered PDF
invoice to that address (e.g. the store owner). Fires from the `order/created` fanout
(`apps/api/src/lib/inngest/functions/order-created.ts`, `send-owner-invoice` step ->
reuses the existing `order/invoice.email-requested` pipeline). Resolver:
`resolveOrderInvoiceRecipient` in `apps/api/src/lib/order-notification-address.ts`
(shared by every sender below). Empty/unset = no owner invoice sent.

This address is also the ONLY place per-order alert mail goes (Ruling FU46-1a): the invoice
it receives for every order IS the new-order notice (there is no separate alert step), and the
refund-processed alert goes to the same address. With no address set, nothing is sent: order
and refund alerts never go to Ebda's own inbox, and no mail goes to owners by default.
Storefront contact-form messages follow the same rule (Ruling FU46-1c): the store's contact
email, else its active owner, else nothing.

## `minimumOrderFils?: number`

Minimum items **subtotal** (in piastres; 100 piastres = 1 EGP) required to place an order.
`0`/unset = no minimum. Enforced in three places (shared helper `checkMinimumOrder` in
`packages/shared/src/utils/minimum-order.ts`):

- **Server (the real guard):** `OrderService.create` throws `AppError(400,
'MINIMUM_ORDER_NOT_MET', …)` — applies to the customer/storefront path, not admin manual
  orders.
- **Cart:** `apps/web/.../cart/CartClient.tsx` disables "Proceed to checkout" + shows an
  "add X more" message below the minimum.
- **Checkout:** `CheckoutClient.tsx` blocks the Pay button + maps the `MINIMUM_ORDER_NOT_MET`
  API code to the same friendly message.
- **Progress (Phase B4):** a look with `chrome.cartBar` shows what is left as a sentence plus a
  progress bar (`MinOrderProgress`) in the cart and in the browse cart bar. Advice only: the three
  guards above are unchanged. See `docs/ebda/templates/platform-commerce.md` § 16.

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
  `timezone`, default `Africa/Cairo`) passes its `orderBy`.
- **Next-day rollover:** once **all** of today's windows have passed their `orderBy`, the
  selector rolls over to **Tomorrow** (all windows selectable again, "Tomorrow" badge).

Availability logic is the pure, unit-tested `resolveDeliverySelection(items, nowMinutes)`
in `apps/web/.../checkout/_lib/deliveryWindows.ts` (`getNowMinutesInTimezone` derives the
store-local minutes). Example — window A order-by 14:00, window B order-by 19:00: at 13:59
both available (today); 14:01 only B; 18:59 only B; 19:01 → tomorrow, both.

### `daysAhead?: number | null` (Phase B4, Ruling B4-7)

An integer 1-14 turns the today / tomorrow picker into a row of **date chips** for the next N delivery
days, each with the store's windows (`DeliveryDateChips`; the first two chips read "النهاردة" / "بكرة").
Absent or `null` = everything above, byte-identical. Validated at the settings edge on create and update
(`addCheckoutDeliveryIssues`: 400 outside 1-14; the rest of `checkoutDelivery` is not re-validated). Edited
on Admin → Delivery ("Delivery date", one select, 0 = off).

What is offered is ONE pure function, `deliveryDateChoices` (`packages/shared/src/commerce/delivery-dates.ts`),
run by the storefront AND by the order endpoint: the first date is today in the store timezone moved forward by
`deliveryDays.min` + the **longest `leadTimeDays` in the cart** BUSINESS days (the `deliveryOffDays` skipped, the
same rule as the PDP chip); today stays on offer only while at least one window can still be booked (`orderBy`,
else `start`); then N consecutive working days. A made-to-order product therefore hides today.

The order payload carries `deliveryDate` (`YYYY-MM-DD`, store-local) and `deliveryWindowId`. `OrderService.create`
(storefront path, `source: web`) **recomputes the set from the live store row** (`resolveOrderDeliveryNote`,
NEVER cached), refuses anything outside it with **422 `DELIVERY_SLOT_UNAVAILABLE`** (a stale date, a hand-edited
past date, a closed window, a missing date), and **writes the delivery line itself**: the first line of `notes`,
`"Delivery: Fri 23 Oct, Evening (6:00 PM–8:00 PM)"` / `"التوصيل: الجمعة 23 أكتوبر، عشا (6:00 م–8:00 م)"` followed by
the customer's own note. The client no longer writes that line for such a store. Other sources (WhatsApp, the agent
checkout) may omit the date; a date they send is validated the same way. A quote (`dryRun`) never refuses on it.
Because the line is the existing `notes` prefix, the receipt, the account order, the admin order, the orders app and
the emails read it unchanged; there is no column, so no structured filter by delivery date until one is added.
The estimate input is the store-wide `deliveryDays.min` (zone estimates depend on the address and are not part of
the date set).

## `deliveryOffDays?: number[] | null`

Weekdays with no delivery, `Date#getUTCDay` numbers (0=Sun ... 6=Sat). Unset/null = `[5]` (Friday). `[]` = delivers every day. Unique integers 0-6, at most 6 entries. The storefront "delivers by" estimate (`deliveryWindow({ offDays })`) skips these days for zone estimates and for the `deliveryDays` fallback. Edited on Admin → Delivery ("Days with no delivery"); null clears (shallow merge). The admin page does not pin the default: an untouched `[5]` on a store with no saved value is omitted from the payload (`offDaysForSave`), so changing `DEFAULT_DELIVERY_OFF_DAYS` later still reaches that store; any explicit choice is sent. Public (`lib/public-store-settings.ts`). Ruling B0-48.

## Editing / adding a setting

The admin delivery page reads the full `settings` object and re-saves it via
`PUT /api/v1/stores/:id` (`StoreService.update` server-side shallow-merges `settings`).
When adding a new key here, add it to the `StoreSettings` type in
`packages/shared/src/types/index.ts` **and** its `.d.ts` mirror.
