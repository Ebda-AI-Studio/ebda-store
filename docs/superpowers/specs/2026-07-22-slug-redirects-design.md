# Slug redirects — never 404 a renamed storefront URL

**Date:** 2026-07-22
**Status:** Approved (design), scope = Products + Categories + Pages + Blog
**Branch:** `feat/slug-redirects`

## Problem

When a storefront entity's slug ("handle") changes, the old URL 404s. External
pointers — Google, AI crawlers (ChatGPT/`utm_source=chatgpt.com`), shared links,
QR codes — keep hitting the old slug and land on a dead end. Link equity and warm
traffic are lost silently; nothing in CI catches it.

Observed in the wild on the client store `pecannbee.com.kw`: products were
re-slugged from numeric-suffix import handles (`raw-pecan-2636297`,
`raw-mix-nuts-2636301` — the suffix came in via the import file's `row.slug`,
from whatever platform the catalog came from before FWB) to clean handles
(`raw-pecan`) with **no 301**. Every indexed/shared old URL now 404s.

FWB has the same structural gap. Current state (verified in code):

- **No slug-history table, no redirect table, no data-driven redirect layer** exist.
- The storefront product route does **not even hard-404** on a missing slug — it
  soft-fails client-side (`apps/web/.../products/[slug]/ProductDetailBody.tsx:124`
  returns `null`, renders a client error state). So a renamed product is a broken
  page with neither a 301 nor a clean 404.
- Numeric-suffix handles come from **bulk import** `row.slug` (the import file
  carries them in from the prior platform), not FWB's generator (which dedups
  with `-1, -2…`). The import path is therefore a first-class slug-change surface.

## Goal

Any storefront request for a slug that has been renamed **301/308-redirects to the
current URL** instead of 404ing. Applies platform-wide, per-store scoped, to
Products, Categories, CMS Pages, and Blog posts. Genuine "nothing here" cases get
a real 404 (fixing the existing soft-404 bug as a side effect).

Non-goals (this pass): store-level slug change (whole-store subdomain/path move) —
deferred to a fast phase 2 because it touches web middleware, custom domains, and
the global-unique `Store.slug`.

## Design

### 1. Data model — one generic table

`packages/database/prisma/schema.prisma`:

```prisma
enum SlugEntityType {
  PRODUCT
  CATEGORY
  PAGE
  BLOG
}

model SlugRedirect {
  id         String         @id @default(cuid())
  storeId    String
  entityType SlugEntityType
  fromSlug   String
  toSlug     String
  createdAt  DateTime       @default(now())
  updatedAt  DateTime       @updatedAt

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, entityType, fromSlug])
  @@index([storeId, entityType, toSlug])
}
```

- `@@unique([storeId, entityType, fromSlug])` — one live redirect per old slug;
  new changes upsert.
- `onDelete: Cascade` on Store — a store delete removes its redirects (matches the
  tenant-delete cascade rule; blast-radius sweep will confirm no orphan path).
- Redirects are keyed to `(store, entityType, slug)`, **not** an entity FK, so
  deleting the underlying product/category does not cascade-delete the redirect.
  If the redirect target itself no longer exists, resolve-on-miss for the target
  finds nothing → clean 404. Acceptable.

### 2. Capture (write side) — `recordSlugRedirect(tx, storeId, entityType, oldSlug, newSlug)`

A single shared helper (in `apps/api/src/services/slug-redirect.service.ts`), called
inside each slug-change chokepoint **within the same transaction** as the entity
write, so capture and rename commit atomically. Logic:

1. No-op if `oldSlug === newSlug`.
2. **Reuse guard:** delete any existing row where `fromSlug === newSlug` (that slug
   is now live again — a live slug must never redirect). Prevents loops.
3. **Chain-collapse:** update every existing row where `toSlug === oldSlug` to
   `toSlug = newSlug` (so `C→A` becomes `C→B` when `A→B` is recorded — never
   multi-hop).
4. **Upsert** `(storeId, entityType, fromSlug=oldSlug) → toSlug=newSlug`.

Capture call-sites (from the code map):

| Entity           | Site                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product          | `ProductService.update` — where `finalSlug !== product.slug` (product.service.ts ~815)                                                                          |
| Product (import) | `bulk.service.ts` / `xlsx-import.ts` — when an existing product's incoming file `row.slug` differs from its stored slug (this is the numeric-handle alias case) |
| Category         | `category.routes.ts` update handler (~483) — factor the write into a service call or wrap in the same tx                                                        |
| Page             | `pages.service.ts` `upsert` — when the addressed row's slug changes                                                                                             |
| Blog             | `blog.service.ts` update — where slug changes                                                                                                                   |

Import note: when a bulk re-import matches an existing product by SKU and the
incoming `row.slug` differs, the import **changes** the stored slug to the
incoming one (verified in `bulk.service` Phase 4). The capture records the old
stored slug → the new one, so a catalog re-import that swaps a numeric-suffix
handle for a clean one (the pecannbee pattern) leaves the old URL redirecting.

### 3. Resolve (read side) — `resolveSlugRedirect(storeId, entityType, slug)`

Public API endpoint `GET /public/redirects/resolve?type=<t>&slug=<s>` → `{ toSlug }`
or 404. Chain-collapse guarantees a single hop; a defensive max-2-hop follow in the
resolver backstops any legacy multi-hop row.

Storefront wiring — in each entity's server route, when the entity lookup returns
null:

1. Call the resolver.
2. Hit → `permanentRedirect('/<path>/<toSlug>')` (Next 308; Google treats it
   identically to a 301 for permanent moves).
3. Miss → `notFound()` (real 404 — **fixes the current soft-404**).

Routes touched: `apps/web/.../products/[slug]/page.tsx` (+ remove the null-render
soft-fail), the category storefront route, the CMS page route, the blog post route.

Happy path is unchanged and pays nothing — the resolver call only fires on a lookup
miss.

**301 vs 308:** default `permanentRedirect` (308). If an exact 301 is required we
move the resolve into `apps/web/middleware.ts` with `NextResponse.redirect(url, 301)`;
noted, not chosen.

## Testing (five layers, per revenue-path rule)

- **Unit** — `recordSlugRedirect`: no-op on equal slugs; reuse guard deletes a
  now-live redirect; chain-collapse rewrites inbound `toSlug`; upsert overwrites.
  `resolveSlugRedirect`: hit/miss, max-hop backstop.
- **Integration** — rename a product slug via `ProductService.update`; old slug
  resolves to new; resolve endpoint returns `{ toSlug }`; import with a changed
  incoming handle records the alias.
- **E2E** — create product, rename it, `GET` the old storefront URL → 308 to the
  new URL; `GET` a never-existed slug → 404.

## Safety / blast radius

- **New FK on a tenant table** → verify Store-delete cascade removes redirects and
  check `information_schema.referential_constraints` for `NO ACTION` children.
- Sweep every slug write path (product update, bulk + xlsx import, category, page,
  blog) — the pattern must be in all of them or it isn't shipped.
- Platform-level, `storeId`-scoped, RLS-covered (write helper runs inside the
  tenant context / same tx as the entity write). No branch on `store.slug`.
- **Docs parity:** update `docs/architecture/` note + the GSC/AI-crawler runbook
  (`docs/runbooks/google-search-console-indexing.md`) to state that renames now
  self-redirect.

## Out of scope (phase 2)

Whole-store slug change (subdomain/path) redirect in web middleware, incl.
custom-domain and global-unique `Store.slug` handling.
