# Demo store (looks showroom)

`stores.is_demo = true` marks the showroom store (`storedemo`, seeded by `scripts/storedemo/seed.mjs`). It does two things and nothing else:

1. **Previews looks.** `?look=<id>` on a demo store renders that look. Applied only when the store `isDemo` AND the look is `status: 'built'` in `@force/shared`'s registry (all 15 are `designed` until Phase B, so the bar and the preview are inert in production until then). The preview goes through the one composition path every store uses: `applyDemoLook` (`apps/web/src/lib/demo-look.ts`) replaces `template` (the look's skin), `look` and `theme` (`composeStoreTheme`, no merchant overrides) on the resolved store, so `layout.tsx` (`data-look`, font link, CSS vars) needs no parallel mechanism.
2. **Refuses every order.** `assertOrderAllowed` (`plan-limit.service.ts`) throws `403 DEMO_STORE` first, before the entitlement read. Every order-creating path calls it: `OrderService.create` (storefront checkout, public routes, MCP order tools), `OrderService.createAdminOrder`, and the WhatsApp payment link (`payment-links.routes.ts`). `tests/integration/demo-store.test.ts` proves no `orders` / `order_items` row and no stock movement. (There is no separate stock-hold table: a hold is the inventory decrement inside the order transaction.)

## Request flow and caching

- Middleware forwards a well-formed `?look=` (`^(qamar|souq|jasmine|lamma|dahab)\.[a-z]+$`, the `stores_look_format` CHECK) as request header `x-demo-look`. The header is in `MIDDLEWARE_ASSERTED_HEADERS`, so a client-sent copy is stripped.
- Such a request never takes the shared tenant-tree rewrite (`/tenant-store/<host>/<locale>`, the only full-route-cache path) and its response is `Cache-Control: private, no-store`. Middleware is synchronous and cannot ask whether the store is a demo, so the header is set for any store host carrying a well-formed `?look=`; the page of a non-demo store is identical to the one without the param.
- The look is applied after the cached store fetch, per request; the in-memory store map and Next's tagged data cache only ever hold the base store.
- **Edge cache caveat.** The Worker emits `private, no-store`, which a standards-following CDN honours. If a Cloudflare Cache Rule on the zone ever sets "Cache everything" or an edge TTL override for `*.ebda.app` / custom domains, it must bypass when the query string contains `look=`; a rule that ignores origin `Cache-Control` would defeat the header. Not verifiable from the repo (zone rules live in the dashboard).
- Navigating to another page from the demo store drops `?look=` (no cookie by design: a cookie would put the look in a shared-cache key).

## Seeding

`DATABASE_URL=<owner url> npx tsx scripts/storedemo/seed.mjs` prints the plan; it refuses a non-loopback database unless `--yes-production`. Idempotent. No images (nothing is uploaded to R2).
