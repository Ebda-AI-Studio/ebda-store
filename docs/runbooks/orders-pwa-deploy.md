# Orders PWA — Deploy + Domain Runbook

The Orders PWA (`apps/orders`, `@force/orders`) is a focused, installable
order-management app for store staff. It deploys to its **own Vercel project**
on the domain **`orders.forcemediakw.com`** — separate from the admin
(`app.forcemediakw.com`) and storefront (`wadyaljuz.com`) projects.

It is an internal staff tool: every route is `noindex` (next.config.js headers +
`vercel.json` `X-Robots-Tag`).

## 1. Create the Vercel project (one-time)

Mirror the `force-admin` / `force-web` project setup:

1. Vercel dashboard → **Add New… → Project** → import the
   `ForceAI-KW/force-website-builder` repo.
2. **Project name:** `force-orders`.
3. **Root Directory:** `apps/orders` (so Vercel builds only this app).
   Vercel auto-detects Next.js + the npm-workspaces monorepo and installs from
   the repo root. `@force/shared` is consumed via `transpilePackages` in
   `apps/orders/next.config.js`, so Next compiles it from source — no extra
   build step is required.
4. **Framework Preset:** Next.js (auto-detected; also pinned in `vercel.json`).
5. Leave Build/Install commands at the Vercel defaults — the monorepo install
   pulls all workspace deps.

> If a sibling app's deploy ever fails to find `@force/shared` types, enable
> "Include source files outside of the Root Directory in the Build Step" in
> Project Settings → General — but the default monorepo behavior already does
> this here.

## 2. Environment variables (Production + Preview)

Set in Vercel → `force-orders` → Settings → Environment Variables:

| Var                            | Value                                        | Notes                                                                                            |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_API_URL`          | `https://api-production-c058.up.railway.app` | Same Railway API the admin/web use. No `/api/v1` suffix — the app appends it.                    |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | the platform VAPID **public** key            | MUST equal the API's `VAPID_PUBLIC_KEY`. Public key only — the private key NEVER leaves the API. |

The VAPID **private** key (`VAPID_PRIVATE_KEY`) and `VAPID_SUBJECT` live ONLY on
the Railway API (already configured for the storefront push path). The orders
PWA never sees them.

If `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is unset, the app degrades gracefully: the
"Enable notifications" prompt simply never shows and the in-app new-order
watcher (beep + toast) still works.

## 3. Attach the domain `orders.forcemediakw.com`

1. Vercel → `force-orders` → Settings → **Domains** → Add
   `orders.forcemediakw.com`.
2. Vercel shows a DNS target. In the `forcemediakw.com` DNS provider, add the
   record Vercel asks for (typically a **CNAME** `orders → cname.vercel-dns.com`,
   or an A/ALIAS if the apex provider requires it).
3. Wait for DNS propagation + Vercel's automatic TLS cert issuance (Let's
   Encrypt). Status flips to **Valid Configuration** when done.
4. Set `orders.forcemediakw.com` as the **Production** domain for the project.

## 4. Verify after first deploy

- Open `https://orders.forcemediakw.com` → login screen renders.
- Sign in as a store-staff user → orders list loads.
- Install the PWA (Android/desktop Chrome: install banner; iOS: Share → Add to
  Home Screen).
- The **Enable notifications** banner appears post-login (only when push is
  supported, a VAPID key is set, and permission is still default). On iOS it
  shows an "install first" hint until the app runs standalone.
- Tap **Enable** → grant permission → a row lands in
  `push_subscriptions` with `audience = 'orders_app'`.
- Place a test order on that store → within a few seconds a
  **"New order …"** push arrives on the device.

## How push delivery works (reference)

- **Stack:** VAPID Web Push (RFC 8030) via the existing `apps/api`
  `push.service.ts` — NOT OneSignal. OneSignal locks each app to one origin and
  the admin OneSignal app is pinned to `app.forcemediakw.com`; the orders PWA is
  a different origin, so VAPID (platform-wide, origin-agnostic) is the correct
  reuse.
- **Subscribe:** `POST /api/v1/stores/:storeId/orders-app/push/subscribe`
  (authenticated, staff/admin + store-access gated). Tags the row
  `audience = 'orders_app'`.
- **Delivery:** the existing `order/created` Inngest fanout
  (`order-created.ts`) gains an `orders-app-push` step calling
  `pushService.sendToOrdersAppStaff(storeId, …)`. It targets ONLY the
  `orders_app` audience (never shoppers, never the OneSignal admin app — no
  double-send), respects the store's `order_confirmed → push` opt-in, and runs
  inside `runInTenantContext` (FORCE-RLS-safe in the Inngest job).
- **Idempotency:** the notification `tag` is `order-<orderId>`, so a retried
  Inngest step collapses onto a single notification instead of stacking.
