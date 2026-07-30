# Frontend Trust-Boundary Audit — force-website-builder (2026-07-15)

**Scope:** read-only audit of the client/server trust boundary across the three
Next.js frontends — `apps/web` (storefront), `apps/admin`, `apps/orders` — against
the API (`apps/api`, Express, different domain, cross-origin cookie auth).
`AuthProvider` is the only client auth checker per app; RLS + `authorize()` /
`requireStoreAccess` / `requireFeature` are the server-side enforcement points.
No code was modified.

**Cross-refs:** `docs/audits/2026-07-15-session-timeout-ux.md` (Lens S — the
session-kick `returnTo` fix this audit re-examines for open-redirect), and
`docs/audits/2026-07-02-feature-flags.md` (billing-leak 4-layer audit, most
relevant to item 1 below). No `Lens K` or `Lens P` trust-boundary notes exist
anywhere in `docs/audits/` — grepped the full directory tree, zero hits. The
task's instruction to cross-reference them could not be honored; flagging
rather than silently skipping, per the "fix everything / never silently drop"
house rule. If they exist under a different name/location, point me at it and
I'll fold in the diff.

## Tally

**1 Critical · 0 High · 2 Medium · 0 Low** (plus 2 "verified already fixed"
notes carried over from the 2026-07-02 feature-flag audit, and one explicit
gap in the task's own cross-ref instruction, above)

| #   | Severity     | Item                                                                                                                                                | Status                                        |
| --- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| C1  | **Critical** | Open redirect via backslash-URL bypass in login `returnTo`/`redirect` validation                                                                    | CONFIRMED                                     |
| M1  | Medium       | `X-Store-ID`/`x-store-id` header is client-supplied and trusted for tenant-tagging on a few customer-scoped routes (wishlist; cart/session-scoped)  | CONFIRMED (bounded — no privilege escalation) |
| M2  | Medium       | Client-side response-shape trust (`apiGet<T>()` unchecked casts) is systemic across ~49 admin call sites; only spot-checked, not exhaustively swept | PLAUSIBLE (needs full sweep)                  |

---

## C1 — CRITICAL — Open redirect via backslash-URL bypass in login redirect validation

**Files:**

- `apps/admin/src/lib/auth.tsx:182-189` (`postLoginDestination()`, the fix
  called out in `docs/audits/2026-07-15-session-timeout-ux.md` M1, merged
  today)
- `apps/web/src/app/auth/login/LoginClient.tsx:42-46` (`redirectTo` validation
  — pre-existing, not part of today's fix, but the same defect class)

Both validate a client-supplied redirect target with the same insufficient
check:

```ts
// apps/admin/src/lib/auth.tsx:185
if (raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/login')) {
  return raw;
}
```

```ts
// apps/web/src/app/auth/login/LoginClient.tsx:44-45
const redirectTo = rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') ? rawRedirect : '/';
```

Both intend to block protocol-relative URLs (`//evil.com`) but only check for
a literal double-forward-slash prefix. The WHATWG URL spec (implemented
identically by every browser and by Node's `URL`) treats a **backslash** as
equivalent to a forward slash for "special" schemes (http/https) when it
appears in the first two characters after the leading slash — so
`/\evil.com`, `/\/evil.com`, and `\\evil.com` all resolve to a **different
origin**, exactly like `//evil.com`, while passing both checks above
(`startsWith('/')` is true, `startsWith('//')` is false — the second
character is `\`, not `/`).

Verified directly against Node's WHATWG-compliant `URL` parser (same
algorithm the browser and Next.js's router use to resolve `router.push()`
targets against `location.href`):

```
"/\\evil.com"   -> https://evil.com/
"/\\/evil.com"  -> https://evil.com/
"//evil.com"    -> https://evil.com/
```

`apps/admin/src/lib/auth.tsx:257` and `:285` call
`router.push(postLoginDestination())` after a successful login/MFA
completion; `apps/web/src/app/auth/login/LoginClient.tsx:46` calls
`router.push(storeUrl(redirectTo))`. Next.js's client router resolves the
`push()` target as a URL against the current origin and, when the resolved
origin differs from the app's own, performs a real browser navigation to it
(this is documented, intentional behavior — `router.push()` supports pushing
absolute external URLs) — so a crafted link causes an actual redirect off the
platform, not just a broken in-app route.

**Attack scenario:** attacker sends a merchant/staff member a link like
`https://admin.force-ai.co/login?returnTo=%2F%5Cevil-phish.com`. It looks
like a legitimate admin.force-ai.co URL (correct domain, correct path) — the
malicious part only surfaces after a successful, real login, when the victim
is silently bounced to `evil-phish.com`, which can now serve a convincing
"session expired, please re-enter your password" page or a malware prompt.
Same mechanism on the storefront login for customer accounts.

**Blast radius / defect-class note:** exactly 2 call sites share this exact
validation idiom (grepped `startsWith('/')` + `startsWith('//')` together
across all three apps — no third occurrence). `apps/orders` has no
`returnTo`/`redirect` param at all (its `auth.tsx:155-159` always pushes a
bare `/login` on a kick), so it isn't affected.

**Mitigating factor found (not a fix, don't rely on it):** on `apps/web`,
`storeUrl()` (`apps/web/src/contexts/StoreContext.tsx:431-473`) prefixes the
path with `/${store.slug}` only on **platform-host** domains
(`store.force-ai.co/<slug>/...`); on that path the prefix breaks up the
leading `/\` pair (`/palora/\evil.com` no longer starts with two
slash/backslash characters, so it parses as a normal same-origin path). But
on **custom domains** — `storeUrl()` returns the path unprefixed
(`if (!prefix) return path;`, line 460) — which is the primary production
traffic pattern per `CLAUDE.md` ("web also serves per-tenant custom domains
via the CF-for-SaaS fallback — the SOLE domain provider since 2026-07-07").
So the storefront instance of this bug is live on every custom-domain store,
unmitigated. The admin app has no store-prefixing concept at all — unmitigated
unconditionally.

**Fix direction (not applied — read-only audit):** reject any redirect target
whose second character is `\` in addition to `/`, or — more robust — parse
the raw value with `new URL(raw, 'http://internal.invalid')` and check
`url.origin === 'http://internal.invalid'` before accepting it as internal.
The existing `!raw.startsWith('/login')` loop-guard in the admin version is
sound and should be kept.

---

## M1 — MEDIUM — Client-supplied `X-Store-ID` header trusted for tenant-tagging on a couple of customer-scoped routes (bounded, not a privilege-escalation path)

**Files:**

- `apps/web/src/lib/api.ts:372-374` (`ApiClient.buildHeaders()` sets
  `X-Store-ID` from `this.storeId`, mutable client-side state set via
  `setStoreId()`)
- `apps/api/src/middleware/tenant-context.ts:112-162` (`userContext()`) —
  explicitly documents that `wishlist.routes.ts` "reads its store from an
  `x-store-id` HEADER, not the URL"
- `apps/api/src/middleware/feature-gate.ts:30-34` (`requireFeature` also
  falls back to `req.headers['x-store-id']` as one of several storeId
  sources)

The storefront's `ApiClient` sends whatever `storeId` is currently held in
its in-memory state as `X-Store-ID` on every request (item 2's literal
question: does the client send a storeId the server trusts?). For the vast
majority of routes this is inert — `requireStoreAccess`
(`apps/api/src/middleware/store-access.ts:14-138`) **re-derives** access from
`Store.ownerId` / `StoreStaff` membership looked up by the authenticated
`userId`, never by trusting the header/param as an authorization decision
(CONFIRMED — this is the correct pattern and the codebase applies it
consistently on admin routes).

The narrower exception is `wishlist.routes.ts` (customer-facing, via
`userContext()`): the store id that scopes a wishlist row comes from the
`x-store-id` header, which the browser fully controls. Because the row is
still filtered by the authenticated customer's `userId` (via
`customerUserId()`, the guard documented at
`apps/api/src/middleware/auth.ts` to stop the admin/customer cookie-sharing
confusion), a spoofed header cannot expose another user's data — worst case
a customer's own wishlist item gets tagged under the wrong tenant. That's a
data-integrity nuisance, not an authorization break, so Medium rather than
Critical/High. Flagging because it's the one place in the codebase where a
storeId literally rides an unauthenticated client header into a write path,
and the comment block at `tenant-context.ts:150-161` already earmarks this
as needing attention once RLS cutover Phase 3 (`force_app`) goes live.

---

## M2 — MEDIUM (PLAUSIBLE, not exhaustively confirmed) — Client-side response-shape trust is systemic; only spot-checked

**Item 5's literal ask:** "any fetch that trusts the response shape
unchecked (typed-fetch contract mismatch → empty tables/silent failure)."

`apps/admin/src/lib/api.ts` has no runtime validation of the API's response
JSON against the generic `T` — `apiGet<T>()` casts `data.data as T` at
`apps/admin/src/lib/api.ts:250` with zero shape checking. This is
architecturally acceptable (the API is same-repo, same-team, and Zod-validated
on the way _in_; the response contract is not adversarial), but it does mean
a server-side field rename or a `{ items }` vs `{ data }` wrapper drift
degrades silently into an empty table rather than an error — exactly the
class of bug the project's own scoped memory documents
(`feedback-typed-fetch-contract-shape-mismatch`,
`feedback-fwb-apiget-double-unwrap`).

I spot-checked 3 of the ~49 `apiGet` call sites in `apps/admin/src` for this
pattern and found all three already defensively coded:

- `apps/admin/src/contexts/StoreContext.tsx:44-47` — explicit
  `Array.isArray(raw) ? raw : []` guard plus a `{stores?} | Store[]` union
  type that mirrors the actual dual-shape API response.
- `apps/admin/src/app/audit-logs/page.tsx:99-104` — `data.logs || []`.
- `apps/admin/src/lib/api.ts:40-47` (`unwrapList`/`unwrapObject`) — shared
  helpers built specifically to normalize the two known wrapper shapes.

Given the 3-sample check came back clean and the codebase has purpose-built
`unwrapList`/`unwrapObject` helpers for exactly this problem, I'm not
escalating this above Medium — but I did not sweep all ~49 call sites (nor
the equivalent surface in `apps/web` and `apps/orders`), so I can't call this
CONFIRMED-clean either. Recommend a dedicated grep-and-read sweep (`await
apiGet<...>` sites that destructure `.data.<field>` without `?.`/`||`/
`Array.isArray`) as a follow-up, not blocking.

---

## Passing items (checked, no finding)

### 1. No business rule decided client-side (pricing/discount/total, feature gating as access control)

**CONFIRMED clean.** Traced the full checkout money path in
`apps/web/src/app/checkout/CheckoutClient.tsx`:

- `total = Math.max(0, subtotal - discount + shipping)` (line 772) is
  **display-only** — fed into the UI (`OrderSummary`) and a GA4 analytics
  `value` field (line 154), never into a request payload.
- `api.createOrder()` (called at line 854) sends `shippingAddress`,
  `paymentMethod`, `notes`, `couponCode`, `pointsToRedeem` — **no price,
  total, or amount field exists in `CreateOrderData`**
  (`apps/web/src/lib/api.ts:275-284`). The code comment at line 882-884
  explicitly notes "the server re-validates against the real balance + caps
  regardless."
- `POST /payments/create` (line 908-916) sends only `orderId`, `provider`,
  and relative `successUrl`/`errorUrl` — no amount. The API derives the
  charge amount from the order it already persisted server-side.
- `apps/web/src/contexts/CartContext.tsx:332`'s `total` reducer is the same
  display/analytics-only pattern.

Feature-gating: `apps/web/src/contexts/FeatureContext.tsx` and the admin
equivalent (`apps/admin/src/hooks/useFeatures.tsx`) are UI-hide helpers only
— they gate what renders, not what the server accepts. Cross-referenced
`docs/audits/2026-07-02-feature-flags.md`, which already did the deep sweep
of every `FeatureKey` for exactly the "UI hide ≠ server gate" gap this item
worries about. Its two most severe findings have since been fixed —
re-verified live in this pass:

- F1 (Critical, admin push-broadcast had zero `requireFeature` gate) — now
  gated: `apps/api/src/routes/onesignal.routes.ts:154`
  (`requireFeature('push_notifications')` inside `adminStoreMiddleware`).
- F2 (High, Kuwait invoice generation had zero gate) — now gated:
  `apps/api/src/routes/order.routes.ts:554` and `:580`
  (`requireFeature('accounting.invoicing')` on both the invoice GET and the
  invoice-email POST).

F3-F7 from that same audit (dead `staff_accounts` flag, affiliate signup
gating, SMS/push config-leak, floating-widget write route, profit-anomaly
routes) were **not** re-verified in this pass — out of scope for a frontend
trust-boundary audit, but flagging that their fix status is unconfirmed as of
today in case a follow-up wants to close the loop.

### 2. `storeId` trust (admin store selection)

**CONFIRMED clean — server-authoritative.** `apps/admin/src/contexts/StoreContext.tsx`
lets the merchant pick an active store client-side
(`setSelectedStoreId`, persisted to `localStorage`), and that id is used
purely as a **URL param / lookup key** in subsequent `apiGet` calls — it is
never treated as an authorization grant. `apps/api/src/middleware/store-access.ts`
(`requireStoreAccess`, lines 14-138) independently re-derives access on
every request from the authenticated JWT's `userId` against
`Store.ownerId` (store_admin) or `StoreStaff` membership (staff), doing a
fresh DB lookup every time — a client sending an arbitrary storeId it
doesn't own gets a DB-verified 403 `FORBIDDEN`, not silent access. `feature-gate.ts`'s
`requireFeature` follows the same "storeId is just a lookup key" pattern.
(One narrower exception — the wishlist header case — is M1 above.)

### 3. Secrets in the bundle

**CONFIRMED clean.** Enumerated every `NEXT_PUBLIC_*` reference across all
three apps' `src/`:

```
NEXT_PUBLIC_API_URL
NEXT_PUBLIC_ONESIGNAL_APP_ID
NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID
NEXT_PUBLIC_POSTHOG_HOST
NEXT_PUBLIC_POSTHOG_KEY
NEXT_PUBLIC_SENTRY_DSN_WEB
NEXT_PUBLIC_SITE_URL
NEXT_PUBLIC_VAPID_PUBLIC_KEY
NEXT_PUBLIC_WEB_URL
```

All nine are genuinely public-safe categories (API base URL, OneSignal app
ids, PostHog project key/host, Sentry DSN, site URLs, VAPID _public_ key —
none are secret-bearing by design). Grepped every `'use client'` file across
all three apps for any non-`NEXT_PUBLIC_` `process.env.*` reference — zero
hits. `next.config.js` in all three apps only reads `SENTRY_ORG` /
`SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` (build-time only, for source-map
upload, never bundled) and CSP-allowlist env vars
(`STOREFRONT_FRAME_ANCESTORS`, `ADMIN_PREVIEW_FRAME_SRC` — non-secret host
lists rendered into a response header, not the JS bundle).

Marketing-pixel/SMS secret masking (the sub-note in item 3): confirmed
server-side masking exists and is exercised —
`apps/api/src/lib/marketing-pixels-secrets.ts:37-50`
(`maskMarketingPixelSecrets`) calls `encryption.mask(val, 4)` (last-4 reveal)
before any pixel credential reaches a GET response, with a matching
"preserve real secret unless the incoming value is still the mask sentinel"
guard on save (lines ~82-100) so a client can't accidentally clobber a real
stored token by round-tripping the masked display value. SMS credentials
(`apps/admin/src/app/stores/[id]/notifications/_components/SmsChannelCard.tsx`)
carry no secret fields client-side at all — no `apiKey`/`authToken` grep
hits in that component; the toggle is env-configured, not per-store.

### 4. Auth/refresh flow correctness

**CONFIRMED clean** across all three apps (`apps/admin/src/lib/api.ts`,
`apps/admin/src/lib/auth.tsx`, `apps/web/src/lib/api.ts`,
`apps/web/src/contexts/AuthContext.tsx`, `apps/orders/src/lib/api.ts`,
`apps/orders/src/lib/auth.tsx`) except for the open redirect covered as C1
above:

- **Loop safety:** every 401-retry path explicitly excludes `/auth/*`
  endpoints from triggering a refresh (`!endpoint.startsWith('/auth/')`), so
  a failed refresh/login call can never recursively trigger another refresh.
  Single-flight `refreshInFlight`/`refreshPromise` module-level promises
  (identical pattern in all three apps' `api.ts`) mean concurrent 401s from
  parallel requests share ONE `/auth/refresh` call instead of racing and
  tripping the server's reuse-detection (which would otherwise cause a
  legitimate concurrent request to trigger a false logout). The admin
  `AuthProvider.checkAuth` also explicitly avoids re-running `/auth/me` on
  every pathname change (`authCheckedRef`, `apps/admin/src/lib/auth.tsx:150-159`),
  with a comment documenting exactly why: it would otherwise race the
  api.ts 401-retry refresh and double-rotate the token.
- **No non-iOS localStorage token leak:** every token write to `localStorage`
  (`accessToken`, `refreshToken`, `csrfToken`) in all three apps is gated
  behind `isIosWebkit()` — verified by reading `storeSession()` /
  `refreshAccessToken()` in all three `auth.tsx`/`api.ts` pairs. On every
  other browser, tokens ride the httpOnly cookie exclusively and are never
  written to JS-readable storage (correctly avoiding XSS-exfiltration
  surface). The rationale (iOS/iPadOS WebKit purges third-party httpOnly
  cookies for installed PWAs) is documented consistently at each call site.
- **No half-authed state found:** failed refresh paths uniformly clear
  `localStorage` tokens and leave `user` at `null`/unset, which the
  redirect-to-login effect then handles; I did not find a path that leaves
  `isAuthenticated: true` with a dead session or vice versa.
- **Open-redirect re-check (the explicit ask):** see C1. The `returnTo`
  validation is real and _mostly_ correct (rejects plain `//...` and the
  `/login` loop) but has the backslash gap.

### 5. Zod at every API edge (client fetch trust)

Covered above as M2 (not fully swept, spot-check clean).

### 6. Middleware

**CONFIRMED clean on all three apps — no auth decisions in middleware.**

- `apps/admin/src/middleware.ts:1-33` is a literal passthrough
  (`return NextResponse.next()`), with an in-file comment explaining exactly
  why a cookie-based redirect check was removed (iOS ITP purges the
  indicator cookie faster than the real session dies, causing false
  bounce-to-login loops) — matches `CLAUDE.md`'s stated invariant ("Do NOT
  add cookie checks to Next middleware"). Auth enforcement lives entirely in
  the API's `authenticate` middleware + the client `AuthProvider`.
- `apps/web/middleware.ts:197-444` is exclusively tenant/domain resolution
  (platform-vs-custom-domain detection, store-slug extraction, the dark-launched
  `STOREFRONT_TENANT_ROUTING` rewrite, the page-builder preview-draft cookie
  propagation with its leak guard at lines 235-278) and the new
  `.well-known/` exclusion in the route matcher (line 475, for RFC 9116
  `security.txt`). None of it reads or checks an auth cookie or token — it
  sets `x-store-domain`/`x-store-slug` headers for tenant _resolution_ only,
  never an authorization decision. The `/tenant-store/*` internal-rewrite
  guard (lines 200-209, `return new NextResponse(null, {status: 404})` for
  any direct external hit) is a tenant-isolation control, not an auth check,
  and is itself sound (prevents any domain from directly addressing another
  tenant's internal route tree).
- `apps/orders` has **no `middleware.ts` file at all** — confirmed via
  `find`. Consistent with the same architecture: the orders PWA's
  `AuthProvider` (`apps/orders/src/lib/auth.tsx`) is the sole client-side
  gate, and its `permissions.ts` client-side `can()`/`effectivePermissions()`
  helper (used to hide order-status controls from read-only staff) is
  UX-only — the actual enforcement is the server's
  `requirePermission('orders:manage')` on
  `PUT /stores/:storeId/orders/:id/status`
  (`apps/api/src/routes/order.routes.ts:506-511`), which I traced against
  `apps/api/src/middleware/rbac.ts:61-72` and confirmed the role→permission
  table matches exactly what the client mirrors — i.e. the client hint and
  the server truth agree today, but the client hint is never load-bearing.

---

## Notes on audit method

Static/source-level analysis only (per "read-only" instruction) — no running
app, no live request testing. The C1 exploitability claim rests on (a) a
direct read of both vulnerable functions, (b) a reproducible Node `URL`
parser test proving the WHATWG spec's backslash-normalization behavior
(pasted above, reproducible with `node -e "..."`), and (c) documented Next.js
App Router behavior (client `router.push()` performs a real browser
navigation when the resolved target's origin differs from the current one).
I did not have a running instance of either app to confirm the exploit
end-to-end in a browser; if higher confidence is wanted before treating this
as launch-blocking, a 5-minute manual repro (`admin.force-ai.co/login?returnTo=%2F%5Cexample.com`
against a dev/staging build) would close that gap.

graphify-out/GRAPH_REPORT.md was read first — it's a broad codebase graph
(8082 nodes, 525 communities, last built at commit `3e889d8c`) with no
trust-boundary-specific summary page, so I fell back to direct source reads
for everything in this report rather than relying on graph community labels.
