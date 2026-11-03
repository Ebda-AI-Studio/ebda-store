# Admin and Orders CSP: nonce + strict-dynamic (SEC-4)

Audit 2026-10-26, finding `M-067`. Status: shipped for `apps/admin` and `apps/orders`. The storefront
(`apps/web`) is deliberately unchanged, see the last section.

## What changed

| Before                                                                                                   | Now                                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `script-src 'self' 'unsafe-inline' 'unsafe-eval' <hosts>` from `next.config.js` `headers()` (build time) | `script-src 'self' 'nonce-<per request>' 'strict-dynamic' <hosts>` built per request in `src/middleware.ts` from `src/lib/csp.ts` |
| Admin allowed `connect.facebook.net` (script) and `www.facebook.com` (connect)                           | Removed: the admin never loads a marketing pixel (pixels run on storefronts). Orders already had no ad hosts.                     |
| Admin had no `script-src-attr`                                                                           | `script-src-attr 'none'` (the storefront and Orders already had it)                                                               |
| `'unsafe-eval'` allowed everywhere                                                                       | Dropped on admin and Orders, see Ruling SEC-4b                                                                                    |

How it works: the middleware mints 128 random bits per request (`newCspNonce`, `@ebda/shared`), puts
`Content-Security-Policy` and `x-nonce` on the REQUEST (Next reads the request policy and stamps the
nonce on its own bootstrap and flight-data scripts), and sets the same policy on the RESPONSE. The admin
root layout reads `x-nonce` for its one inline script (theme flash guard). `'strict-dynamic'` trusts
scripts that a nonced script loads (OneSignal, PostHog), so the host list is only a fallback for
browsers without strict-dynamic support. The Orders root layout is `force-dynamic` so Next renders
every response with a nonce; the admin is already dynamic (next-intl reads headers).

Everything else in the admin's security headers (HSTS, XFO, Permissions-Policy, X-Robots-Tag) stays in
`next.config.js`. The `/stores/:id/builder` frame-src rule (preview of any merchant domain) moved with
the CSP into `src/lib/csp.ts` (`BUILDER_PREVIEW_PATH`).

Tests: `tests/unit/admin-page-builder-preview-csp.test.ts` (policy builder), `csp-nonce-middleware.test.ts`
(fresh nonce per request, request and response policies identical, `x-nonce` set), and
`csp-directive-floor.test.ts` (the ZAP 10055 floor now reads `src/lib/csp.ts` for admin and Orders).

## Rulings

Ruling SEC-4a - admin and Orders ship ENFORCED, not report-only first. A report-only soak with a nonce
is not possible without rendering the nonce anyway, and these two apps are authenticated shells with
no cache to protect. Evidence (measured 2026-10-27): `next build` + `next start` of both apps, loaded in headless
Chromium at `/` and `/login`: admin 29-30 scripts, orders 16-18, every inline script carries the nonce,
0 `securitypolicyviolation` events, 0 CSP console errors (signed-out pages only; authenticated screens
and the builder preview were NOT exercised). Cost if wrong: a script we did
not exercise is blocked and a screen breaks; the revert is one commit (restore the two `headers()`
entries).

Ruling SEC-4b - `'unsafe-eval'` is dropped on admin and Orders. Evidence (measured 2026-10-26): the
OneSignal v16 page SDK loaded from `cdn.onesignal.com` and initialised under a nonce + strict-dynamic
policy WITHOUT `'unsafe-eval'` produced no CSP violation (same run with it allowed: identical), and the
production builds of both apps load clean. NOT verified: the push-subscribe flow behind a real
OneSignal app id (it is fetched from the API at runtime). The vendor docs say the page SDK needs eval;
if a push prompt breaks, set `ADMIN_NEEDS_UNSAFE_EVAL` / `ORDERS_NEEDS_UNSAFE_EVAL` to `true` in
`src/lib/csp.ts` (one line each). Cost if wrong: web push prompts fail in the admin and Orders until
that flag is flipped.

Ruling SEC-4c - the admin keeps its access and refresh tokens in `localStorage` on iOS and iPadOS
WebKit only (installed PWA). Evidence: `apps/admin/src/lib/api.ts` and `auth.tsx` write the tokens
only inside `isIosWebkit()`, and `readStoredRefreshToken` deletes any copy on every other browser; on
desktop and Android the tokens are not in JS-readable storage. The iOS lane exists because ITP purges
the third-party refresh cookie of an installed PWA, so "memory only, re-mint from the cookie" would
sign out every iOS PWA user on each reopen. With the nonce CSP the XSS that could read them is much
harder to land. Cost if wrong: an XSS on an iOS PWA admin reads a 30-minute access token and the
long-lived refresh token. Follow-up if wanted: ship the iOS refresh token as a non-extractable
credential (WebAuthn or a device-bound key), a product change, not a CSP one.

Ruling SEC-4d - SUPERSEDED 2026-10-29 by Ruling CSP-WEB-1 (the storefront now ships the same nonce + strict-dynamic policy, `docs/architecture/storefront-csp.md`). Original text: the storefront (`apps/web`) was NOT changed: Ahmad 2026-09-02 (`storefront-csp.md`) kept
`'unsafe-inline'` because a per-request nonce forces dynamic rendering and forecloses
`STOREFRONT_TENANT_ROUTING` cacheable routes (and the P14 edge-cache work). Its `'unsafe-eval'` stays
for the OneSignal v16 page SDK and its ad hosts for the merchant pixels. `script-src-attr 'none'`
already blocks injected inline handlers there. Cost if wrong: an injected inline `<script>` on a
storefront runs; escaping at every sink (storefront-csp.md) is the control.

## Review notes (Opus review of this branch)

- The middleware matcher skips only Next internals and a few named static files (`/_next/static`,
  `/_next/image`, `/icons/`, favicons, `/health`, `/sw.js`, `/manifest.webmanifest`,
  `/OneSignalSDK*.js`), NOT "anything with a file extension": a dynamic route such as `/foo.svg` or
  `/stores/a.b/settings` still gets the nonce CSP. Pinned in `csp-nonce-middleware.test.ts`.
- Static assets (served by the Workers asset layer, never by middleware) get a strict fallback CSP from
  `public/_headers` for `*.svg` and `/icons/*` (`default-src 'none'`, `frame-ancestors 'none'`), so an
  SVG opened directly cannot run script. The workers (`sw.js`, `OneSignalSDKWorker.js`) are deliberately
  not covered: a restrictive CSP on a service worker would break its fetch/importScripts.

Ruling SEC-4e - there is NO static fallback CSP in `next.config.js` `headers()`. Evidence:
`@opennextjs/aws` `routingHandler.js` merges config headers over middleware headers unless
`dangerous.middlewareHeadersOverrideNextConfigHeaders` is set (not set for admin or Orders), and the
config key is cased differently from the middleware's lower-case key, so on Workers the static policy
would either replace the nonce policy (inline scripts blocked, app broken) or be emitted beside it
(intersection, same result). `tests/unit/csp-nonce-middleware.test.ts` fails if either config sets a
CSP again. Cost if wrong: a response that bypasses middleware has no CSP; the matcher exclusions and
`_headers` rules above are the cover.

- The invoice srcdoc frame inherits the admin CSP; its in-document Print button (inline `onclick`) is
  stripped in the admin view, the page has its own Print button. Injected script inside the invoice,
  fiscal and packing-slip frames is now blocked too.
- Known, not fixed: the prerendered `/_global-error` page has no nonce (its retry button will not
  hydrate on a server crash; the text still shows); if the Cloudflare zone auto-injects the Web
  Analytics beacon it arrives without a nonce and strict-dynamic blocks it (turn the zone setting off
  or add the beacon through code); the builder preview `frame-src https:` applies only when
  `/stores/:id/builder` is loaded directly, not after in-app navigation (predates this change).
- Token storage, precisely: access and refresh tokens reach `localStorage` only on iOS WebKit
  (verified in admin and Orders `api.ts` / `auth.tsx`); the CSRF token is in `localStorage` on every
  browser; an XSS on desktop could still call `/auth/refresh` with the cookie and read the JSON
  body, so the protection is the CSP, not the storage location.
- NOT verified: behaviour on OpenNext/Workers (only `next start` was run), signed-in screens, and the
  OneSignal push-subscribe flow without `'unsafe-eval'`.

## connect-src and the identity service (Ruling CSP-ACCOUNTS-1)

Admin and Orders sign in from the browser against the shared identity service (`apps/*/src/lib/accounts.ts` fetches `NEXT_PUBLIC_ACCOUNTS_URL`, default `https://accounts.ebda.app`, with credentials). Both CSP builders therefore name exactly that one origin in `connect-src` (`accountsOrigin()` in each `lib/csp.ts`, https or loopback only, no wildcard). `tests/unit/csp-connect-src-covers-browser-clients.test.ts` fails when an app reads a `NEXT_PUBLIC_*_URL/ORIGIN/HOST` base that is not decided in its table, or whose origin is missing from that app's `connect-src`.

## Admin push opt-in (2026-11-03, audit G-1 follow-up)

The OneSignal SDK no longer loads on admin page load. It is lazy-loaded by one click ("enable order alerts on this device",
`components/EnableOrderAlertsButton.tsx` -> `lib/push-opt-in.ts`), and the OneSignal hosts are in the admin CSP ONLY for
`PUSH_OPT_IN_PATH` (`/account/devices`, `/stores/:id/notifications`). Every other route has no onesignal host. The service
worker (`public/OneSignalSDKWorker.js`) stays, so existing subscriptions keep receiving pushes. Guard: `tests/unit/admin-no-onesignal.test.ts`.

