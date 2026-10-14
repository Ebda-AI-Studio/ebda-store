# Orders PWA — focused, installable order-management app

**Date:** 2026-06-15
**Branch:** `feat/orders-pwa`
**Status:** v1 for review

## Why

Ahmad wants a dedicated **"focus mode" order app** — a separate installable PWA that
does ONE thing well: order management. The full admin (`apps/admin`) is a broad
control plane (page builder, branding, products, accounting, AI tools…). When a
merchant or their staff are working the floor / fulfilling orders, they want a
phone-home-screen app that opens straight onto live orders with one-tap status
updates and a new-order alert — not the whole admin.

This is a NEW workspace app (`apps/orders`) that authenticates against the **same
FWB API** and reuses the **same contracts** as `apps/admin`. No backend changes.

## Non-goals (v1)

- No new API endpoints. Everything reuses existing `/stores/:storeId/orders*` routes.
- No order creation / phone-order entry (that stays in the full admin).
- No refunds / payment-link issuing / invoice email (full admin keeps those).
- No accounting, products, branding, analytics — out of scope by design.
- No native push delivery wiring in v1 (OneSignal SDK init deferred to v2 — see below).

## Architecture decisions

### 1. Auth — reuse the admin Bearer-token pattern verbatim

The API and frontends are on different domains; iOS PWAs purge third-party
cookies. `apps/admin/src/lib/api.ts` + `lib/auth.tsx` already solved this:

- Login → `POST /api/v1/auth/login` → store `accessToken` + `refreshToken` in
  `localStorage`, send `Authorization: Bearer <accessToken>` on every request.
- Transparent refresh-on-401 via `POST /api/v1/auth/refresh` (single-flight),
  retry once.
- `/auth/me` on mount to restore session.

The Orders PWA ports this code (`lib/api.ts` + `lib/auth.tsx`) with the same
single-flight refresh + Bearer path, restricted to admin roles
(`super_admin` / `store_admin`). **Same contract, not a fork** — the wire
protocol is identical; the file is a focused copy minus the MFA-enroll redirect
(the PWA assumes the merchant already enrolled via the full admin).

### 2. i18n — client-side LanguageContext (EN/AR + RTL), not next-intl server config

The full admin uses `next-intl` with a server `request.ts` reading a cookie.
The Orders PWA is a fully client-rendered SPA-style PWA (offline-installable,
no server-side locale negotiation needed), so it ships a lightweight
client `LanguageContext` with a flat `t()` lookup + `dir="rtl"` switch
persisted to `localStorage`. Smaller surface, no server round-trip, works
offline. Strings live in `src/i18n/messages.ts` (EN + AR).

### 3. Store selection

Reuses `GET /api/v1/admin/stores` (same as admin `StoreContext`). A store
picker in the header; selection persisted to `localStorage`. Single-store
merchants auto-select.

### 4. Orders data — existing endpoints only

| Action          | Endpoint                                           | Notes                                        |
| --------------- | -------------------------------------------------- | -------------------------------------------- |
| List            | `GET /stores/:id/orders?page&limit&status&from&to` | response `{ orders, meta }`                  |
| Detail          | `GET /stores/:id/orders/:orderId`                  | response `{ order }`                         |
| Status update   | `PUT /stores/:id/orders/:orderId/status`           | body `{ status }`, Zod-validated server-side |
| Mark paid (COD) | `POST /stores/:id/orders/:orderId/mark-paid`       |                                              |

Status filters: `new` (UI alias for `pending`) / `paid` / `processing` /
`shipped` / `delivered`. The API status enum is
`pending|confirmed|processing|shipped|delivered|cancelled|refunded`; the
`paid` filter is a client concept = `paymentStatus==='paid'` shown via the
existing status set. Transition rules mirror `VALID_TRANSITIONS` from the admin.

### 5. Staff-role awareness

The staff-role/permission work is in flight (`rbac.ts` is currently
role-derived: `store_admin` has `orders:manage`, `customer` does not). v1
derives the permitted action set client-side from `user.role` using the **same
`rolePermissions` table** as `rbac.ts`, with a forward-compatible
`user.permissions?: string[]` override so that when the API starts returning an
explicit per-staff permission array, the PWA honors it with zero changes. A
viewer without `orders:manage` sees orders read-only (status controls hidden).

### 6. PWA — manifest + service worker + installable + push subscription stub

- `public/manifest.webmanifest` — standalone display, name, icons, theme color
  (Force orange `#ff6e00`), `start_url`, EN/AR aware.
- `public/sw.js` — a minimal service worker: precache the app shell, network-first
  for API calls (never cache authed responses), offline fallback. Registered
  client-side after load.
- New-order notification: in v1 a **polling + in-app toast + sound** (Web Audio
  beep) when the live list gains a new `pending` order. The push-subscription
  scaffold (`Notification.requestPermission` + service-worker `push` handler) is
  wired but OneSignal/VAPID delivery is a v2 task (needs a separate OneSignal app
  id + the API to target the orders-PWA subscription) — documented as deferred.

### 7. Mobile-first + RTL

Tailwind (same config shape as admin: Force palette + HSL tokens). Layout is a
bottom-nav focus shell, ≥44px touch targets, logical-property classes (`ms`/`me`/
`ps`/`pe`) so RTL flips correctly. Dark-mode-ready via the same `class` strategy.

### 8. Validation / security

- Zod at every input edge (login form, status-update payload) — `@ebda/shared`
  is available but to keep the PWA dependency surface minimal v1 validates the
  two inputs with small local Zod schemas.
- No secret leakage: only `NEXT_PUBLIC_API_URL` (+ optional
  `NEXT_PUBLIC_ONESIGNAL_APP_ID` for v2) read client-side. No provider names,
  no infra detail in client bundle.
- Security headers + CSP mirror the admin's `next.config.js`.
- `noindex` headers (internal tool).

## File layout (apps/orders)

```
apps/orders/
  package.json            # @ebda/orders, next dev -p 3002
  next.config.js          # standalone, headers/CSP, outputFileTracingRoot
  tailwind.config.js postcss.config.js tsconfig.json
  public/
    manifest.webmanifest  sw.js  icon-*.png (placeholder)
  src/
    app/
      layout.tsx          # html lang/dir, providers, SW register
      globals.css
      providers.tsx       # Auth + Store + Language + Toast
      page.tsx            # → /orders (or /login)
      login/page.tsx
      orders/page.tsx     # live list + filters + store picker
      orders/[orderId]/page.tsx  # detail + status actions
    lib/
      api.ts auth.tsx     # ported Bearer + refresh pattern
      permissions.ts      # role→permission table (mirrors rbac.ts)
    contexts/
      StoreContext.tsx LanguageContext.tsx
    components/
      OrderCard.tsx StatusBadge.tsx StatusActions.tsx
      BottomNav.tsx StorePicker.tsx LangToggle.tsx
      NewOrderWatcher.tsx (poll + beep + toast)
    i18n/messages.ts
    pwa/register-sw.ts
```

## Test plan (v1)

- `npm run build -w apps/orders` succeeds (typecheck + Next build).
- Manual: login → orders list renders against real API → filter by status →
  open detail → change status → toast + list reflects it → install prompt
  appears (Chrome) → AR toggle flips `dir=rtl`.
- Prettier clean on all changed files (CI gate).

## Deferred to v2

- OneSignal/VAPID push **delivery** (subscription scaffold is in v1; targeting
  the orders-PWA audience + API send is v2).
- Real-time via Socket.io (admin has `NotificationContext` wired-but-inactive;
  v1 uses polling instead — simpler, no new infra).
- Sound/notification preferences UI.
- Vercel project + custom domain (`orders.forcemediakw.com`) provisioning.
- Honoring an explicit per-staff `permissions[]` array once the API returns one
  (code path is already forward-compatible).
- Offline order queue (mutations while offline).
