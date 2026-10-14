# Storefront CSP — why `script-src 'unsafe-inline'` stays

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

Measured on a live storefront page (`pecannbee.com.kw`, 2026-09-02):

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
(`docs/plans/2026-07-12-tenant-cacheable-routing.md`), whose entire purpose is
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
Pinned by `tests/unit/csp-directive-floor.test.ts`. `apps/admin` can take the same
line; it was not part of that change.

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
- `docs/plans/2026-07-12-tenant-cacheable-routing.md` — the caching work.
- `apps/web/next.config.js` — the policy itself.
