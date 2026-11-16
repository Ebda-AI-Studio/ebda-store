# Storefront CSP: nonce + `strict-dynamic` (Ruling CSP-WEB-1, 2026-10-29)

**Status: the nonce policy below is SHIPPED. It supersedes the 2026-09-02 decision further down
(kept as the record of the measurement and the trade-off).** The policy is built per request in
`apps/web/middleware.ts` from `apps/web/src/lib/csp.ts`: `script-src 'self' 'nonce-<per request>'
'strict-dynamic' <host fallbacks>`, with no `'unsafe-inline'` and no `'unsafe-eval'` for scripts.
`next.config.js` no longer emits a CSP (it would be doubled or override the nonce one on OpenNext).

## What carries the nonce

- Next's own bootstrap and flight-data scripts: Next stamps the nonce when the REQUEST carries the policy
  (the middleware puts `Content-Security-Policy` and `x-nonce` on it).
- The root layout's one executable inline script (dark-mode guard): `nonce={nonce}` from `x-nonce`.
- The merchant pixels (`MarketingPixels.tsx`, `next/script`): `nonce` prop, and `'strict-dynamic'` trusts what
  they load. JSON-LD blocks are data, never executed, so they need none.
- OneSignal and PostHog load through a nonced script and are trusted by `'strict-dynamic'`.

## Why the 2026-09-02 reasons no longer hold

- "A nonce forces dynamic rendering": measured 2026-10-29, every storefront route is already dynamic and
  `no-store` (31 of 32 route files are `force-dynamic`; the build prerenders only `/_global-error`).
  `STOREFRONT_TENANT_ROUTING` is off by default and nothing caches storefront HTML today except the
  opt-in worker edge cache below.
- "`'unsafe-eval'` is required by OneSignal": admin and Orders shipped without it (SEC-4b) and the SDK
  initialised with no violation; the storefront follows (`STOREFRONT_NEEDS_UNSAFE_EVAL = false` in
  `src/lib/csp.ts`, one line to restore).

## Residuals (accepted, Ruling CSP-WEB-1)

- The worker HTML edge caches (`demo-edge-cache.ts`, `store-edge-cache.ts`) store the rendered page with the nonce
  it was rendered with. A HIT or STALE response is therefore never served as stored: `csp-nonce-renew.ts` mints a
  fresh nonce per response and replaces the old one in the CSP header and throughout the streamed body (attributes
  and the flight payload), so no two visitors share a nonce and the stored one is never sent to anyone but the
  visitor who triggered the MISS. Test: `tests/unit/edge-cache-nonce.test.ts` (two hits, two nonces, header and
  body agreeing).
- If `STOREFRONT_TENANT_ROUTING` caching is ever turned on for real, its cached HTML has the same shape:
  decide then between a per-request nonce (no HTML caching) and hash/`strict-dynamic` bootstrap.
- `/_global-error` is prerendered with no nonce: when the root layout itself crashes its scripts are blocked
  and the static fallback shows without hydration.
- Pixel vendors that inject further inline script rely on `'strict-dynamic'`; a browser without it falls
  back to the host list and the nonce on the pixel scripts we render.

Tests: `tests/unit/web-csp-nonce-middleware.test.ts`, `csp-directive-floor.test.ts`,
`storefront-frame-ancestors-prod.test.ts`, `storefront-csp-google-ads.test.ts`, `edge-cache-nonce.test.ts`. Browser checks:
`node scripts/qa/storefront-csp-check.mjs` against a local `next start` (every demo template, ar and en) and
`node scripts/qa/storefront-pixel-csp-check.mjs` (a store with GTM and Meta pixels configured, real loader code,
stubbed vendor endpoints).

---

# Storefront CSP: why `script-src 'unsafe-inline'` stayed (superseded 2026-10-29)

**Decision (Ahmad, 2026-09-02): keep `'unsafe-inline'`. Do not introduce a nonce.**

This file exists so the question is not re-litigated from scratch, and so the
measurement behind the decision survives.

## The finding

The 2026-09-02 adversarial audit flagged that the storefront CSP carries
`script-src 'unsafe-inline' 'unsafe-eval'`, which makes `script-src` a no-op
against injected inline script: any `<script>` or inline handler that reached
the page would execute. Every storefront defence against stored XSS therefore
rests entirely on output-escaping being correct, with no CSP backstop.

## Why it cannot simply be removed

Measured on a live storefront page (`demo-store.example`, 2026-09-02):

```
74 <script> tags total
  22 with src=
  52 inline, of which:
       48 bare inline blocks — self.__next_f  (Next.js RSC flight data)
        4 type="application/ld+json"          (data, not executable)
```

The 48 are emitted by **Next.js itself** to stream server-rendered data for
hydration. No application-level change removes them. Drop `'unsafe-inline'`
without another mechanism and the storefront stops working.

`'unsafe-eval'` is separately required by the OneSignal v16 page SDK
(documented at https://documentation.onesignal.com/docs/web-push-csp).

## Why a nonce was rejected

A nonce is the supported way to keep inline scripts working under a strict CSP:
the server mints a random value per request, puts it in the header and on each
legitimate inline script, and the browser runs only those.

It must differ per request or it is forgeable — which means the HTML cannot be
reused, so **a nonce forces dynamic rendering**. Next.js documents this: a route
using a nonce opts out of the Full Route Cache.

That directly conflicts with `STOREFRONT_TENANT_ROUTING`
(`docs/plans/done/2026-07-12-tenant-cacheable-routing.md`), whose entire purpose is
to make anonymous storefront routes cacheable by resolving the store from route
params instead of `headers()`. Shipping a nonce would permanently foreclose it.

Hashes are not an alternative here: Next's flight-data blocks differ per page,
so no fixed hash set can cover them.

## What tipped the decision

The CSP is a backstop, and at the time of the decision nothing was reaching it.
The audit attacked every plausible injection sink and broke none:

- JSON-LD `</script>` breakout — `jsonLdScriptContent` escapes `<`, `>`, `&`,
  U+2028/U+2029 after `JSON.stringify`; every emitter routes through it.
- CMS pages — never stored as HTML; re-rendered from `contentBlocks` through
  `renderBlocksToHtml`, which escapes and allowlists URL schemes.
- Theme/font CSS — `sanitizeFontValue` / `sanitizeThemeColor` block `{`, `}`,
  `<`, `>`, `url(`, `@import`, `expression(`, `javascript:`.
- Merchant `<a href>` surfaces — all pass `sanitizeUrl` / `isSafeUrl`.
- R2 uploads — content-type allowlisted to images (SVG excluded), served from a
  separate `*.r2.dev` origin that cannot script the storefront.

The damage-bounding directives are already in place: `base-uri 'self'`,
`object-src 'none'`, `form-action 'self'`, and a scoped `frame-ancestors`.

## Done since: inline event-handler attributes (2026-10-14, Ruling S10-1)

`script-src-attr 'none'` is set on `apps/web` and `apps/orders`. It is a separate
directive from `script-src`, so Next's inline flight data keeps working while an
injected `onclick=` / `onerror=` attribute no longer runs. `unsafe-inline` and
`unsafe-eval` in `script-src` are unchanged (decision above; OneSignal needs eval).
Pinned by `tests/unit/csp-directive-floor.test.ts`. `apps/admin` took the same
line in SEC-4 (2026-10-26), together with a full nonce + `strict-dynamic` CSP that has no
`'unsafe-inline'` or `'unsafe-eval'` in `script-src`: see `docs/architecture/admin-csp.md`. The
storefront decision above is unchanged.

## The tripwire — when to revisit

Reopen this decision if **any** of these becomes true:

1. A stored-XSS sink is found on the storefront (an escaper regresses, or a new
   surface renders merchant or customer content as HTML).
2. A feature ships that renders merchant-supplied HTML rather than text.
3. `STOREFRONT_TENANT_ROUTING` is abandoned — the caching roadmap is the only
   thing a nonce costs, so without it the nonce becomes cheap.

A partial option also exists and was considered: nonce on personalised routes
(cart, checkout, account) and the current policy on cacheable anonymous routes.
It was not taken because the merchant-authored content that would carry stored
XSS lives on the anonymous pages, so it would protect the lower-risk half.

## Related

- `docs/audits/2026-09-02-adversarial-audit.md` — the finding and the attacks
  that were tried against the escapers.
- `docs/plans/done/2026-07-12-tenant-cacheable-routing.md` — the caching work.
- `apps/web/src/lib/csp.ts` — the policy itself (built per request by `apps/web/middleware.ts`).

## connect-src names exact hosts (S5, 2026-11-12)

`connect-src` no longer carries `https://*.r2.dev`, `https://*.facebook.com` or `https://*.tiktok.com`: a wildcard on a storage or ad domain is an exfiltration channel for any injected script (anyone can host a bucket or page there). It names `https://media.ebda.app` (media + the 3D `.glb` fetch), `https://www.facebook.com` + `https://connect.facebook.net` (Meta Pixel beacons) and `https://analytics.tiktok.com`. An environment that serves media from one specific `pub-<id>.r2.dev` bucket names that exact origin through `NEXT_PUBLIC_MEDIA_ORIGIN`. `media-src` still allows `*.r2.dev` (video elements cannot exfiltrate); narrowing it is a separate change. Guard: `tests/unit/csp-directive-floor.test.ts`.

## Marketing site (ebda.app) CSP (S6, 2026-11-12)

`apps/marketing/public/_headers` now ships `default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `script-src-attr 'none'`, `object-src 'none'`, `base-uri 'self'`, `frame-src 'none'` and a self + `api.ebda.app` `connect-src`, on top of the old `frame-ancestors` / `form-action`. The marketing site is a static export on Workers Static Assets, so the per-request nonce CSP of web/admin/orders is not possible there, and Next's inline flight scripts differ on every page (too many hashes for Cloudflare's 2000-character `_headers` line). Residual: `'unsafe-inline'` for scripts (no `unsafe-eval`, no remote script host); the site renders no user-supplied HTML. Guard: `tests/unit/marketing-contact-page-and-csp.test.tsx`. Not verified live until the marketing deploy runs: check every locale page and the 3D viewer for CSP violations in the console.
