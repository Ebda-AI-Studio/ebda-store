# Slug redirects

_Added 2026-07-22 (`feat/slug-redirects`)._

When a merchant renames a product handle, category slug, or blog post slug,
the old storefront URL must keep working — it 308-redirects to the current
URL instead of 404ing or silently serving stale content. This doc describes
the data model, the capture points that populate it, and the two consumers
(the public resolve endpoint and the storefront's redirect-on-miss).

## Data model

`SlugRedirect` (`packages/database/prisma/schema.prisma`):

```
SlugRedirect(id, storeId, entityType: SlugEntityType, fromSlug, toSlug, createdAt, updatedAt)
@@unique([storeId, entityType, fromSlug])
@@index([storeId, entityType, toSlug])
```

`SlugEntityType` = `PRODUCT | CATEGORY | PAGE | BLOG`. `PAGE` is a reserved
enum value with no active capture path (see "What's excluded" below).

- `storeId` FK → `stores.id` **ON DELETE CASCADE** — deleting a store cleans
  up its redirect rows automatically (verified: `ON DELETE CASCADE` in
  migration `20260722180843_add_slug_redirect`).
- **RLS**: tenant-isolated with `FORCE ROW LEVEL SECURITY` + policy
  `rls_slug_redirect_tenant` (migration `20260722190000_slug_redirect_rls`),
  mirroring the standard tenant-table pattern (e.g. `rls_products_tenant`).
  The policy's `current_store_id() IS NULL OR "storeId" = current_store_id()`
  shape means it is enforced when a tenant context is set and permissive
  otherwise.
- **RLS execution posture (by capture site, intentional):**
  - **Category / Blog** capture runs inside the request's _ambient_ tenant
    transaction (the `tenantContext` middleware wraps the whole admin request
    in one `runInTenantContext` tx), so `"storeId" = current_store_id()` and
    RLS is actively enforced. These sites deliberately do **not** open a
    nested `prisma.$transaction` (which would use the base client, drop the
    `SET LOCAL`, and nest a tx on the pooler).
  - **Product update** (`withMoneyTx`) and **bulk import** (`withMoneyTx` per
    50-row batch) run **context-free** — a deliberate design, not an
    oversight: the product route is mounted at both the cross-tenant
    super-admin `/admin/products/:id` surface (where `tenantContext` is a
    no-op) and the tenant-scoped `/stores/:storeId/products/:id` surface, and
    a single context-free tx serves both; bulk import batches specifically to
    avoid one long-held tenant tx on large uploads. On these paths the policy
    takes its `current_store_id() IS NULL` branch. Isolation is guaranteed by
    the composite-key `(storeId, entityType, fromSlug)` scoping plus the
    server-derived `storeId` on every query — the RLS layer is defense-in-depth
    here, not the primary guard. (Decision 2026-07-22: accepted as-is;
    a `withTenantMoneyTx` refactor to add active RLS to these hot paths was
    considered and deferred as non-exploitable.)
  - The **public resolver** reads with the module-level client (no tenant
    context) and is always `storeId`-scoped in its `WHERE` — the `NULL` branch
    permits the read; correctness comes from the query scope, not RLS.

## Write path — `recordSlugRedirect`

`apps/api/src/services/slug-redirect.service.ts` exports
`recordSlugRedirect(tx, storeId, entityType, oldSlug, newSlug)`. Must be
called inside the same Prisma transaction as the entity's slug write. It:

1. **Reuse guard** — deletes any existing row where `fromSlug === newSlug`
   (the new slug is live again; it must never redirect to something else).
2. **Chain-collapse** — rewrites any row whose `toSlug === oldSlug` to point
   at `newSlug`, so a slug is never more than one hop from its current value.
3. **Upserts** `oldSlug → newSlug`.

No-ops when `oldSlug`/`newSlug` are empty or identical.

### Capture sites (4)

| Entity   | File                                                                       | Trigger                                                                                                                                       |
| -------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Product  | `apps/api/src/services/product.service.ts` (`ProductService.update`)       | Merchant edits a product's handle in the admin.                                                                                               |
| Product  | `apps/api/src/services/bulk.service.ts` (bulk/xlsx import, SKU-match path) | Re-importing an existing product (matched by SKU) with a different handle changes the stored slug — captured the same way as a manual rename. |
| Category | `apps/api/src/routes/category.routes.ts` (`PUT` handler)                   | Merchant renames a category slug.                                                                                                             |
| Blog     | `apps/api/src/services/blog.service.ts` (`BlogService.update`)             | Merchant renames a blog post slug.                                                                                                            |

## Read path — `resolveSlugRedirect` + public endpoint

`resolveSlugRedirect(storeId, entityType, slug)` (same service file) follows
the chain (capped at 3 hops as a defensive backstop for legacy/non-collapsed
rows — the write path above keeps chains collapsed to 1 hop in the normal
case) and returns the final slug, or `null` on a miss.

`GET /public/redirects/resolve?type=product|category|blog|page&slug=<old>`
(`apps/api/src/routes/public.routes.ts`) is the public HTTP surface:

- Validates `type` (maps to a `SlugEntityType`) and non-empty `slug` **before**
  resolving the store id (avoids a DB round-trip on malformed input) → `400`
  on invalid input.
- Resolves the store via `getStoreIdFromRequest` (X-Store-ID header or
  `x-store-domain`), then calls `resolveSlugRedirect` → `200 { toSlug }` on a
  hit, `200 { toSlug: null }` on no redirect. A store that does not resolve is
  still `400 STORE_NOT_RESOLVED`. "No redirect" was a `404` until 2026-11-10;
  the public router's per-IP store-miss limiter counts every 404, so one dead
  product link cost a shopper two misses (the product 404 plus this lookup).
  The storefront reads only `toSlug`, so it handles both answers.

## Storefront consumer — redirect-on-miss

`apps/web/src/lib/slug-redirect.ts` exports:

- `fetchSlugRedirect(store, type, slug)` — calls the resolve endpoint above.
- `storeRedirectUrl(store, path)` — builds the correct absolute URL for
  either a custom-domain store or a platform-path store (`/​<slug>` prefix),
  mirroring the same rule used by `sitemap.ts`.

Three storefront render bodies call these on a miss and issue a real
`permanentRedirect()` (HTTP 308, not a client bounce):

1. **`ProductDetailBody.tsx`** (`/products/[slug]`) — `type: 'product'`.
2. **`BlogPostBody.tsx`** (`/blog/[slug]`, shared by both the legacy and
   tenant-store blog routes) — `type: 'blog'`.
3. **`ProductsPageBody.tsx`** (`/products?category=<slug>`) — `type: 'category'`;
   only fires when the `?category=` value doesn't match any live category
   slug, and only redirects on an actual hit — an unknown filter with no
   redirect row falls through unchanged (no new 404 introduced for that case).

All three skip the demo store (`store.id === 'demo'`) — the demo store has no
backing redirect data and keeps its prior render-with-null-data behavior.

**Genuine misses hard-404.** Prior to this feature, a real store with no
matching product/post silently rendered the page with null content (a
soft-404, invisible to monitoring and useless to users). That is removed:
`type: 'product'` and `type: 'blog'` now call `notFound()` when there is no
redirect hit, producing a real 404.

## Admin surface — list + delete (#903)

Added 2026-09-25: the data model had no admin UI at all, so a merchant could
not see or remove a spuriously-captured bulk-import alias, or a stale
redirect blocking an old slug being re-purposed for something new.

- **API** — `apps/api/src/routes/slug-redirects.routes.ts`:
  `GET /stores/:storeId/slug-redirects?q=&limit=&cursor=` (list, newest
  first then id, 200 per request by default — `limit` up to 500 — returned as
  `{ rows, total, limit, nextCursor }`; pass `nextCursor` back as `cursor` for
  the next page, `null` on the last one (issue 2255), so every row is
  reachable by browsing; `q` filters by a case-insensitive fragment of either
  slug)
  and `DELETE /stores/:storeId/slug-redirects/:id` (delete scoped to BOTH
  `id` and `storeId`, so a merchant cannot delete another tenant's row).
  `authenticate → authorize('store_admin','super_admin') → requireStoreAccess`,
  same order as every other admin route. Backed by `listSlugRedirects` /
  `deleteSlugRedirect` in `slug-redirect.service.ts`.
- **Admin UI** — `/stores/[id]/seo/redirects`, linked from the main SEO
  settings page. Search box, a "showing the newest N of M" notice whenever
  rows are not all loaded yet plus a "Load more" button that appends the next
  page, and errors as a banner above the table (a failed
  delete never unmounts it; a failed load offers a retry). **Read + delete only** — there is deliberately no
  create/edit form, since rows are written exclusively by
  `recordSlugRedirect` alongside the entity rename that produced them.

## What's excluded

- **`SlugEntityType.PAGE`** — CMS `StorePage` rows are looked up by slug via
  `pages.service` with no update-triggered rename capture, so there is no
  write path to populate `PAGE` redirects today. The enum value is reserved
  for future use; the storefront resolve-on-miss consumers likewise skip
  `PAGE`. A renamed CMS page slug needs a manual redirect (e.g. a Cloudflare
  rule) until a capture path is built.
