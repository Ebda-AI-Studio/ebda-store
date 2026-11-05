# Orders PWA — Deploy + Domain Runbook

> **SUPERSEDED (2026-07).** The Orders PWA now deploys as the Cloudflare Worker
> `ebda-orders` (`orders.ebda.app`) via `cf-deploy.yml` — the same
> GitHub Actions pipeline that builds `apps/web` and `apps/admin` (see
> `docs/DEPLOYMENT.md` and `docs/migration/cloudflare-ci-deploy.md`). The Vercel
> project this runbook describes creating is decommissioned; the steps below are
> kept for historical context only.

The Orders PWA (`apps/orders`, `@ebda/orders`) is a focused, installable
order-management app for store staff. It deploys to its **own Vercel project**
on the domain **`orders.ebda.app`** — separate from the admin
(`store.ebda.app`) and storefront (`demo-merchant.com`) projects.

It is an internal staff tool: every route is `noindex` (next.config.js headers +
`vercel.json` `X-Robots-Tag`).

## 1. Create the Vercel project (one-time)

Mirror the `force-admin` / `force-web` project setup:

1. Vercel dashboard → **Add New… → Project** → import the
   `Ebda-AI-Studio/ebda-store` repo.
2. **Project name:** `force-orders`.
3. **Root Directory:** `apps/orders` (so Vercel builds only this app).
   Vercel auto-detects Next.js + the npm-workspaces monorepo and installs from
   the repo root. `@ebda/shared` is consumed via `transpilePackages` in
   `apps/orders/next.config.js`, so Next compiles it from source — no extra
   build step is required.
4. **Framework Preset:** Next.js (auto-detected; also pinned in `vercel.json`).
5. Leave Build/Install commands at the Vercel defaults — the monorepo install
   pulls all workspace deps.

> If a sibling app's deploy ever fails to find `@ebda/shared` types, enable
> "Include source files outside of the Root Directory in the Build Step" in
> Project Settings → General — but the default monorepo behavior already does
> this here.

## 2. Environment variables (Production + Preview)

Set in Vercel → `force-orders` → Settings → Environment Variables:

| Var                                   | Value                                        | Notes                                                                          |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_API_URL`                 | `https://api-production-c058.up.railway.app` | Same Railway API the admin/web use. No `/api/v1` suffix — the app appends it.  |
| `NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID` | the Orders OneSignal app id                  | Public app id for the SEPARATE OneSignal app whose origin = `orders.ebda.app`. |

The Orders OneSignal **REST API key** (`ONESIGNAL_ORDERS_REST_API_KEY`) and the
matching `ONESIGNAL_ORDERS_APP_ID` live ONLY on the Railway API — the orders PWA
never sees the REST key. OneSignal locks one app per origin, so this is a
DISTINCT OneSignal app from the admin (`store.ebda.app`) and storefront
(`store.ebda.app`) ones; create it with `orders.ebda.app` as the
site URL.

Also set **`ORDERS_URL=https://orders.ebda.app`** on the Railway API —
it's the base for the push deep-link (`${ORDERS_URL}/orders/:id?store=:storeId`).
It defaults to `http://localhost:3002` (the orders dev port), so if it's unset
in production the push still arrives but its tap-through link points at
localhost. Set it before launch.

If `NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID` is unset, the app degrades gracefully:
the "Enable notifications" prompt simply never shows and the in-app new-order
watcher (beep + toast) still works. The backend also skips the orders-app push
silently when `ONESIGNAL_ORDERS_APP_ID` / `ONESIGNAL_ORDERS_REST_API_KEY` are
unset.

> **Migration note (2026-06-24):** the orders PWA was moved OFF the old VAPID
> web-push path (which hit a server 403 + was unreliable on iOS) onto OneSignal,
> mirroring the working admin flow. `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is no longer
> used by this app.

## 3. Attach the domain `orders.ebda.app`

1. Vercel → `force-orders` → Settings → **Domains** → Add
   `orders.ebda.app`.
2. Vercel shows a DNS target. In the `ebda.app` DNS provider, add the
   record Vercel asks for (typically a **CNAME** `orders → cname.vercel-dns.com`,
   or an A/ALIAS if the apex provider requires it).
3. Wait for DNS propagation + Vercel's automatic TLS cert issuance (Let's
   Encrypt). Status flips to **Valid Configuration** when done.
4. Set `orders.ebda.app` as the **Production** domain for the project.

## 4. Verify after first deploy

- Open `https://orders.ebda.app` → login screen renders.
- Sign in as a store-staff user → orders list loads.
- Install the PWA (Android/desktop Chrome: install banner; iOS: Share → Add to
  Home Screen).
- The **Enable notifications** banner appears post-login (only when push is
  supported, the Orders OneSignal app id is set, and permission is still
  default). On iOS it shows an "install first" hint until the app runs
  standalone.
- Tap **Enable** → grant permission → the device opts in via OneSignal and is
  tagged `store_id = <selected store>` (verify in the OneSignal dashboard →
  Audience → the device shows the `store_id` data tag).
- Place a test order on that store → within a few seconds a
  **"New order …"** push arrives on the device.

## How push delivery works (reference)

- **Stack:** OneSignal Web SDK (`react-onesignal` v3.5.1), mirroring the admin
  flow. OneSignal locks each app to one origin, so the orders PWA uses its OWN
  OneSignal app (origin `orders.ebda.app`) — distinct from the admin
  (`store.ebda.app`) and storefront (`store.ebda.app`) apps, so
  the three never double-send.
- **Init:** `apps/orders/src/components/OneSignalInit.tsx` inits the SDK
  post-auth with the Orders app id + the static `/OneSignalSDKWorker.js`. It
  does NOT prompt — the prompt rides the Enable button (a user gesture, which
  iOS requires).
- **Subscribe:** the Enable button (`EnableNotifications.tsx` →
  `lib/push.ts:enableOrderPush`) calls `OneSignal.Notifications.requestPermission()`,
  opts the device in, sets the `store_id` tag, and `OneSignal.login(userId)`.
  No server-side subscribe POST (that 403'd on the old VAPID path) and no DB
  player-id storage — the tag IS the targeting key.
- **Delivery:** the existing `order/created` Inngest fanout
  (`order-created.ts`) `orders-app-push` step calls
  `OneSignalService.notifyOrdersAppOfOrder(...)`. It targets ONLY devices tagged
  `store_id = <orderStoreId>` (tenant-isolated), deep-links to
  `${ORDERS_URL}/orders/:id?store=:storeId`, and runs inside the per-order
  fire-once claim (`order_created_notified_at`) so it fires exactly once.
- **Deep-link:** OneSignal opens the notification's `url` natively on click →
  the order detail page (`/orders/[orderId]`).
