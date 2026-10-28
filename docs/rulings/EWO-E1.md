# EWO-E1

> Section: Cluster E — middleware, headers, static assets

**Ruling EWO-E1 — #2153: middleware strips every header it asserts before deriving them; the
two matcher-excluded routes that read them are an accepted residual.** `MIDDLEWARE_ASSERTED_HEADERS`
(`x-is-platform`, `x-store-slug`, `x-store-slug-source`, `x-store-domain`, `x-store-identifier`,
`x-preview-draft`, `x-original-host`) is deleted from the copied request headers first, so only the
Host / URL / cookie / preview params can set them. The class was wider than the issue named: a
spoofed `x-store-domain` on a platform URL made `/llms.txt` and `/feeds/products.json` answer as
another store under `public, s-maxage`. Pinned by the `#2153` block in
`tests/unit/web-middleware-characterization.test.ts` (3 cases red with the strip removed). Residual:
`/api/store-favicon` is outside the matcher and still reads a raw `x-store-domain` on a DIRECT hit
(its only intended caller is the middleware rewrite); the worst outcome is a 302 to another store's
public favicon for the requester, and the path has no extension Cloudflare caches by default. Cost if
wrong: a shared cache configured to cache `/api/*` would serve that redirect to other visitors of the
same host for up to an hour.
