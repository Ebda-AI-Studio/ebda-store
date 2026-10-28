# DRM-1

> Section: Backlog batch d-routes-mcp (2026-10-01)

**Ruling DRM-1 — the AI product feed keeps its 600s cache and 24h edge SWR across a bundle's
sale-window boundary; the two storefront bundle routes do not (issue 2111).** The public bundle
list and detail routes now cache the window-independent state (`sellableIgnoringWindow` + the
window) and apply `withinSaleWindow` on every request, so an expiry or a start takes effect on the
next request with no invalidation. The feed (`public:products:<id>:feed:v1`) is an advertising
artifact served from the Cloudflare edge with `s-maxage=600, stale-while-revalidate=86400`: an
origin-side window check cannot reach the edge copy, and the edge window dominates any Redis TTL
change. Every selling path (cart add, order-create) re-resolves the bundle live and refuses an
expired one. The WhatsApp catalogue calls `listPurchasableBundles` uncached, so it is exact.
Cost if wrong: an AI shopping agent can recommend a promotional bundle for up to ~10 minutes (edge
SWR aside) after it expired, and the shopper is refused at add-to-cart.
**Superseded (issues 2327, 2328, backlog batch x-api):** the feed now does what the bundle routes do.
Its cache key is `public:products:<id>:feed:v2` and holds the feed's INPUTS with each bundle's
window (`listSellableBundles`), not the built feed; `withinSaleWindow` is applied per request, and
the edge `s-maxage` + `stale-while-revalidate` are capped so they end before the nearest future
`startsAt`/`expiresAt` (`nextSaleWindowBoundarySeconds`) — a store with no dated bundle keeps
600s / 24h. The WhatsApp catalogue keeps `listPurchasableBundles` (uncached, window applied at
call time). Cost if wrong: a store with a boundary coming up gets edge misses on its feed until it
passes (at most one origin render per request in the last seconds before it).
