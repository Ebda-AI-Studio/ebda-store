# Storefront Customization + Order Ops + Push Notifications — Master Plan

**Date:** 2026-04-26
**Status:** Draft, awaiting approval
**Scope:** 3 epics, ~10–14 days of work, shippable in independent slices

This plan consolidates four separate user requests into one prioritized, phased roadmap:

1. Storefront layout toggles (admin can turn each home section on/off, pick layout variants, all 5 templates stay consistent)
2. Admin order detail page (mobile-style card layout matching the screenshot)
3. Admin printable invoice page
4. Order list pagination tightening
5. OneSignal push notifications scoped to store admin + super admin

Each epic is independently shippable. Recommended order: **Epic B → Epic C → Epic A** because B+C are smaller, ship value immediately, and don't touch the storefront.

---

## Epic A — Storefront Layout Toggles & Cross-Template Consistency

**Goal:** every section of the storefront home + PLP is admin-toggleable, with layout variants. All 5 templates render the same enabled/disabled set of sections; only the _styling_ varies per pack. Logo size, image sizes, spacing locked to one consistent contract.

**Builds on:** `docs/superpowers/specs/2026-04-26-pecannbee-home-flow-design.md` (already merged).

### A.1 Data model — `stores.layout_settings` JSONB

New JSONB column on `stores`:

```ts
interface StoreLayoutSettings {
  // Hero
  hero: {
    enabled: boolean;
    mode: 'single' | 'slider'; // 'single' = one banner, 'slider' = autoplay carousel
    autoplayMs: number; // 5000 default; ignored when mode = single
    slides: HeroSlide[]; // 1 for single, ≤6 for slider
  };

  // Categories
  categories: {
    enabled: boolean;
    layout: 'grid' | 'horizontal'; // 3-up grid (default) OR horizontal scroll strip
    captionPosition: 'below' | 'overlay';
    desktopColumns: 2 | 3 | 4;
    mobileColumns: 1 | 2;
  };

  // Product carousels (each independently toggleable)
  newArrivals: { enabled: boolean; limit: number };
  bestSellers: { enabled: boolean; limit: number };

  // PLP filter sidebar
  filterSidebar: { enabled: boolean; defaultOpen: boolean };

  // Testimonials
  testimonials: { enabled: boolean; minRating: number; verifiedOnly: boolean };

  // Global consistency contract (shared across all templates)
  sizing: {
    heroAspect: '2.45:1' | '16:9' | '4:3';
    productImageAspect: '1:1' | '3:4';
    categoryImageAspect: '1:1' | '3:4' | '2:3';
  };
}
```

```sql
ALTER TABLE stores ADD COLUMN layout_settings JSONB NOT NULL DEFAULT '{...sane defaults...}';
```

Defaults are populated to match the Pecannbee spec (hero slider, 3-up category grid, caption-below, both carousels on, sidebar on, testimonials on if reviews exist).

### A.2 API — `/admin/stores/:storeId/layout`

`GET /admin/stores/:storeId/layout` → returns `layout_settings`.
`PUT /admin/stores/:storeId/layout` → validates with Zod schema, writes JSONB.

`GET /public/stores/:storeId/layout` → public, used by storefront to render sections.

### A.3 Admin UI — `apps/admin/src/app/stores/[id]/layout/page.tsx`

New admin page with toggle cards, organized into sections:

- **Hero** — `Switch` for enabled, `Tabs` for mode (Single / Slider), upload images, autoplay slider
- **Categories** — toggle, layout radio (Grid / Horizontal), columns selector, caption position
- **Product Carousels** — two independent toggle cards (New Arrivals, Best Sellers) with limit input
- **Filter Sidebar** — toggle + defaultOpen
- **Testimonials** — toggle + min rating slider + verified-only switch
- **Sizing Contract** — radio groups for the 3 aspect ratios (locked across templates so all packs render the same proportions)

Live preview iframe at the right side showing the storefront with current toggles applied.

### A.4 Storefront — shared `T.HomeComposition` orchestrator

Each template's `app/page.tsx` is replaced with a single shared `<HomeComposition layout={layoutSettings} />` component that reads the toggles and conditionally renders:

```tsx
{layout.hero.enabled && (
  layout.hero.mode === 'slider'
    ? <T.HeroSlider slides={layout.hero.slides} autoplayMs={layout.hero.autoplayMs} />
    : <T.HeroBanner slide={layout.hero.slides[0]} />
)}
{layout.categories.enabled && (
  layout.categories.layout === 'grid'
    ? <T.CategoryGrid {...} />
    : <T.CategoryStrip {...} />
)}
{layout.newArrivals.enabled && <T.ProductCarousel sort="newest" limit={layout.newArrivals.limit} />}
{layout.bestSellers.enabled && <T.ProductCarousel sort="best_seller" limit={layout.bestSellers.limit} />}
{layout.testimonials.enabled && <T.TestimonialRow {...} />}
```

Each `T.*` component lives per-pack (`apps/web/src/templates/<pack>/`). The orchestrator + schema is shared. **The orchestrator guarantees every pack renders the same set of sections in the same order at the same sizes** — the only thing each pack overrides is the styling (radius, weights, colors, hover behavior).

### A.5 Per-pack contract enforcement

Add a `__layoutContract` constant exported by each pack's `index.ts`:

```ts
export const __layoutContract = {
  heroAspectAllowed: ['2.45:1'],
  productImageAspect: '1:1',
  categoryImageAspect: '1:1',
  logoMaxHeightPx: 96, // matches the global big-logo decision from earlier
  productGridColumns: { mobile: 2, tablet: 3, desktop: 6 },
};
```

Build-time check ensures every pack honors the same contract. Lints out drift.

### A.6 Phases

- **A.1** schema migration + Zod schema (1d)
- **A.2** GET/PUT API + RLS-aware service (0.5d)
- **A.3** admin layout page UI (2d)
- **A.4** `T.HomeComposition` orchestrator + missing T.\* components per pack (`HeroBanner`, `CategoryStrip`, `ProductCarousel`, `TestimonialRow`) (4d — 5 packs × ~0.8d each, with shared scaffolding)
- **A.5** consistency-contract lint + visual diff (0.5d)

**Estimated:** 8 days end-to-end.

---

## Epic B — Order Detail Page (admin)

**Goal:** clicking an order in the admin orders list opens a detail page that matches the screenshot — mobile-first card layout, action buttons fixed at bottom, designed for the sales/dispatch user.

### B.1 Route — `apps/admin/src/app/stores/[id]/orders/[orderId]/page.tsx`

Currently no detail page exists; the orders list is the only screen. The new route shows:

| Section       | Content                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header strip  | Back button, `INV-26-007` (order number), context menu (overflow)                                                                                                                                         |
| Delivery card | Icon + "Delivery" title, address block (country/city/area, block/street/avenue/house, both languages if entered), `Deliver by:` carrier name, `Deliver at:` slot, "Edit delivery status" link (top-right) |
| Payment card  | Status pill (Unpaid/Paid/Partial), amount, "Remain X" if partial, payment link if applicable, "Edit payment" link                                                                                         |
| Summary card  | Subtotal, Discount (with %), Taxes, Delivery, Total — bold                                                                                                                                                |
| Items card    | Product list, **paginated/limited** (see B.3)                                                                                                                                                             |
| Platform card | Web / App / POS source                                                                                                                                                                                    |
| Customer card | Name, phone, email, "Send WhatsApp" / "Call" quick actions                                                                                                                                                |
| Sticky footer | `Processed` (green primary) / `Cancel` (outline destructive) / `⋯` overflow → Print Invoice, Refund, Add Note, Mark Paid, etc.                                                                            |

Mobile-first; on desktop the cards arrange in a 2-column grid (Delivery+Payment+Customer left, Summary+Items+Platform right) with the sticky footer becoming a fixed bottom bar.

### B.2 Layout component shape

Reuse `Card`, `Badge`, `Button` from `@ebda/ui`. New shared components:

- `<OrderHeaderBar order={order} />`
- `<DeliveryCard order={order} onEdit={…} />`
- `<PaymentCard order={order} onEdit={…} />`
- `<OrderItemsCard items={…} previewLimit={5} />` ← see B.3
- `<OrderSummaryCard totals={…} />`
- `<OrderActionFooter order={order} />`

### B.3 Items list — preview + "View all"

Spec: "the products list do not show all products there is like a count limit".

Show first 5 items inline. Below that, a `View all (12)` row that:

- on mobile → opens a bottom-sheet with the full list
- on desktop → expands inline

Each item row: thumbnail, name (1 line, truncated), variant, qty × unit price, line total.

### B.4 Permissions / API

Endpoint already exists: `GET /admin/stores/:storeId/orders/:orderId`. Confirm it returns:

- order with line items + product names + variants
- shipping_address, billing_address
- payment_status, payment_method, payment_link
- shipping_carrier name + slot
- platform (web/app/pos)

Add fields that don't yet exist (`platform`, `slot_at`) if missing — verify in schema first.

### B.5 Phases

- **B.1** route scaffolding + data fetch (0.5d)
- **B.2** card layout + mobile-first responsive (1.5d)
- **B.3** items list with preview + bottom-sheet/expand (0.5d)
- **B.4** action footer with status mutations + overflow menu (1d)

**Estimated:** 3.5 days.

---

## Epic C — Printable Invoice Page

**Goal:** dedicated invoice page that's both viewable in-browser and print-optimized. Existing `InvoiceService` (462 lines, generates HTML server-side) is solid — just needs an admin-side page that renders it + a print button + a download-PDF action.

### C.1 What already exists

- `apps/api/src/services/invoice.service.ts` — generates a tenant-themed printable HTML invoice with the store brand color.
- `GET /admin/stores/:storeId/orders/:orderId/invoice` → returns the HTML.
- `GET /public/orders/:orderId/invoice` (token-protected) → customer-facing.

### C.2 What to add

**`apps/admin/src/app/stores/[id]/orders/[orderId]/invoice/page.tsx`** — a thin wrapper that:

1. Fetches the HTML from the API
2. Renders it in an iframe (so the styling is fully isolated from the admin Tailwind CSS)
3. Provides a top toolbar with `Print`, `Download PDF`, `Email to Customer`, `Back to Order`
4. The `Print` button calls `iframe.contentWindow.print()` — uses the existing `@media print` CSS in the invoice HTML
5. The `Download PDF` button uses the browser's "Save as PDF" via `print()` (no PDF lib needed; the invoice HTML already has print-optimized CSS)
6. The `Email to Customer` action POSTs to `/admin/stores/:storeId/orders/:orderId/invoice/email` (new endpoint that uses the existing communication-hub email infrastructure)

### C.3 Audit existing invoice CSS

Quick visual review of the invoice HTML output — confirm it matches the brand color, includes:

- Store logo + name + address + tax registration #
- Customer name + phone + email + address
- Line items table (image thumbnail, name, qty, unit price, total)
- Subtotal, discount, tax, shipping, **total** (bold)
- Payment status badge (Paid / Unpaid)
- Footer with terms + "Powered by Force"

If anything is missing (e.g. tax registration), fix it in `invoice.service.ts`.

### C.4 Phases

- **C.1** admin invoice page with iframe + print button (0.5d)
- **C.2** download-PDF + email-to-customer actions (0.5d)
- **C.3** visual polish + tax/legal field audit (0.5d)

**Estimated:** 1.5 days.

---

## Epic D — Order List Pagination Tightening

**Goal:** the orders list already has pagination scaffolding (`OrdersPagination.tsx`, `limit: 20`), but visually the page may show all rows on a tall screen. Tighten to a clean per-page count.

### D.1 Changes

- Default `limit` = 25 (currently 20 — bump to 25 per UX request)
- Add a per-page selector (10 / 25 / 50 / 100) in the pagination footer
- Persist user's per-page choice in `localStorage` per-store
- Server-side: confirm `GET /admin/stores/:storeId/orders` enforces a hard cap (`Math.min(limit, 100)`) to prevent pulling 10k rows
- Empty state: already exists (`EmptyOrdersState.tsx`) — confirm it shows when `total === 0`

### D.2 Phases

**Estimated:** 0.5 day. Bundled with Epic B.

---

## Epic E — OneSignal Push Notifications

**Goal:** when a new order is created on the storefront, push a notification to:

- the **store admin(s)** of the store that received the order (NOT all admins)
- **super admin(s)** (always notified)
- never to admins of other stores

### E.1 Credentials sourcing

Beethoven uses `ONESIGNAL_APP_ID` + `ONESIGNAL_API_KEY` (REST API key). The `.env.example` has placeholders only — actual credentials live in Beethoven's deployed environment.

**Action:** user fetches the real values from Beethoven's hosting (Railway / wherever), then we add them to:

- `apps/api` Railway env (`ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`)
- `apps/admin` Vercel env (`NEXT_PUBLIC_ONESIGNAL_APP_ID`)
- `apps/web` Vercel env (only if storefront also opts in; not required for this scope)

**Note for plan reviewer:** since both Beethoven and Force Website Builder would use the same OneSignal app, all subscription IDs + tags share one namespace. If you want strict separation, create a _separate_ OneSignal app for FWB. Recommendation: separate app — cleaner isolation, free tier is generous.

### E.2 Schema additions

```sql
-- New table: tracks each admin's OneSignal subscription IDs
CREATE TABLE onesignal_subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL,           -- OneSignal subscription / player ID
  device_label  TEXT,                     -- "Chrome on Mac", "Safari on iPhone" — for the user to manage devices
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX onesignal_subscriptions_user_player_uniq ON onesignal_subscriptions (user_id, player_id);
```

`User` model already has `role` ('store_admin' | 'super_admin') and `store_id` (for store_admin).

### E.3 Admin PWA wiring (`apps/admin`)

1. Install `react-onesignal` (or use the OneSignal Web SDK directly).
2. Add `OneSignalSDKWorker.js` to `apps/admin/public/`.
3. Initialize in `apps/admin/src/app/providers.tsx` after auth — only when `user` is authenticated and `Notification.permission !== 'denied'`.
4. On subscription, capture `playerId` + tag the user with:
   ```ts
   OneSignal.User.addTag('user_id', user.id);
   OneSignal.User.addTag('role', user.role); // 'store_admin' | 'super_admin'
   if (user.storeId) OneSignal.User.addTag('store_id', user.storeId);
   ```
5. POST `playerId` to `/admin/notifications/subscribe` so the backend can also store it (for direct-target notifications, not just tag-filter ones).
6. New screen: `apps/admin/src/app/account/devices/page.tsx` — lets an admin see + revoke their registered devices.

### E.4 Backend notification on order create

**`apps/api/src/services/order.service.ts`** — at the end of `createOrder()`, after the order is committed:

```ts
// Fire-and-forget OneSignal push to scoped recipients
notificationService
  .notifyAdminsOfOrder(order)
  .catch(err => logger.error('OneSignal notify failed', { orderId: order.id, err }));
```

**`apps/api/src/services/onesignal.service.ts`** — new service:

```ts
async function notifyAdminsOfOrder(order: Order) {
  const headings = { en: 'New order', ar: 'طلب جديد' };
  const contents = {
    en: `${order.orderNumber} from ${order.customerName} — ${formatPrice(order.total, order.currency)}`,
    ar: `${order.orderNumber} من ${order.customerName} — ${formatPrice(order.total, order.currency)}`,
  };
  const url = `${ADMIN_BASE_URL}/stores/${order.storeId}/orders/${order.id}`;

  await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      headings,
      contents,
      // Filter: (store_id = order.storeId) OR (role = super_admin)
      filters: [
        { field: 'tag', key: 'store_id', relation: '=', value: order.storeId },
        { operator: 'OR' },
        { field: 'tag', key: 'role', relation: '=', value: 'super_admin' },
      ],
      url,
      web_buttons: [{ id: 'view', text: 'View order', url }],
      data: { orderId: order.id, storeId: order.storeId },
    }),
  });
}
```

**Critical:** the `filters` array enforces the scoping rule. Store admin of store A only sees their store's orders. Super admin sees everything. Other store admins see nothing.

### E.5 Test plan

- Subscribe two browser sessions: one as store_admin of store A, one as store_admin of store B
- Create an order in store A → A receives push, B does not, super admin receives push ✓
- Verify clicking notification → opens `/stores/A/orders/<id>`
- Test revoking permission → no longer receives pushes
- Test on iOS Safari (push works on iOS 16.4+ with PWA installed)

### E.6 Phases

- **E.1** OneSignal app provisioning + env vars in Railway + Vercel (0.5d, includes user fetching creds)
- **E.2** schema migration for `onesignal_subscriptions` (0.25d)
- **E.3** admin PWA SDK init + tag setup + devices page (1d)
- **E.4** backend `notifyAdminsOfOrder` + hook into order.service (0.5d)
- **E.5** test on multiple roles + iOS PWA (0.5d)

**Estimated:** 2.75 days.

---

## Total estimate

| Epic                                            | Days                 |
| ----------------------------------------------- | -------------------- |
| A — Layout toggles + cross-template consistency | 8                    |
| B — Order detail page                           | 3.5                  |
| C — Invoice page                                | 1.5                  |
| D — Order list pagination polish                | 0.5 (bundled with B) |
| E — OneSignal push                              | 2.75                 |
| **Total**                                       | **~16 days**         |

## Recommended shipping order

1. **Week 1:** Epic B + C + D (5–6 days) — high-value admin UX, no schema/template churn, ships immediately
2. **Week 2:** Epic E (3 days) — push notifications, requires user to fetch Beethoven OneSignal creds first
3. **Week 3+:** Epic A (8 days) — biggest churn, touches all 5 templates + admin + DB

## Open questions for confirmation before starting

1. **Epic A — separate per-template overrides?** The plan locks toggles per _store_, applying the same set to whichever template the store has selected. Should an admin be able to override per-template (e.g. "if I switch to Bold, also turn off testimonials")? My read: no — toggles are tenant config, template just changes visual style. **Confirm.**

2. **Epic E — separate OneSignal app for FWB?** Recommend yes, to keep Beethoven and FWB subscription pools independent. **Confirm.**

3. **Epic E — push to customers too?** Spec says "notify the admin". Customer order-status push (out for delivery, delivered) is out of scope here; can be a separate epic. **Confirm.**

4. **Epic C — generate real PDFs (server-side) or rely on browser print-to-PDF?** Browser print is simpler and works today. Real PDF generation needs `puppeteer` / `playwright` (heavy on Railway) or a service like Browserless. Recommend browser print for now. **Confirm.**

5. **Epic B — order status mutations from this page** — do you want all status transitions (pending → confirmed → packed → shipped → delivered → returned) inline on the detail page, or just the two from the screenshot (Processed / Cancel)? **Confirm.**

---

## Files this plan will touch (high level)

### Schema

- `packages/database/prisma/schema.prisma` — add `Store.layoutSettings` JSONB, `OneSignalSubscription` model

### API (`apps/api`)

- `src/routes/store-layout.routes.ts` (new)
- `src/services/onesignal.service.ts` (new)
- `src/services/order.service.ts` (extend)
- `src/services/invoice.service.ts` (audit / minor edits)

### Admin (`apps/admin`)

- `src/app/stores/[id]/layout/page.tsx` (new)
- `src/app/stores/[id]/orders/[orderId]/page.tsx` (new)
- `src/app/stores/[id]/orders/[orderId]/invoice/page.tsx` (new)
- `src/app/account/devices/page.tsx` (new)
- `src/app/providers.tsx` (extend with OneSignal init)
- `src/components/order-detail/*` (new — DeliveryCard, PaymentCard, etc.)
- `public/OneSignalSDKWorker.js` (copy from Beethoven)

### Storefront (`apps/web`)

- `src/components/HomeComposition.tsx` (new orchestrator)
- `src/templates/<pack>/HeroBanner.tsx` (new — single banner variant)
- `src/templates/<pack>/CategoryStrip.tsx` (new — horizontal variant)
- `src/templates/<pack>/ProductCarousel.tsx` (new)
- `src/templates/<pack>/TestimonialRow.tsx` (new)
- `src/templates/<pack>/index.ts` (export `__layoutContract`)
- `src/app/page.tsx` (replace with `<HomeComposition>`)

### Shared

- `packages/shared/src/types/store-layout.ts` (new — `StoreLayoutSettings` interface + Zod schema)
