# Store Locations — runbook

Per-store physical **Locations / Branches** feature: a bilingual (EN/AR), RTL-aware
storefront `/locations` page listing a store's branches, plus admin CRUD. Platform-wide,
default **OFF**; enabled per store. Brand-inheriting — every color/font comes from the
store's theme tokens, so each store's page matches its own brand.

## Data model

`StoreLocation` (`packages/database/prisma/schema.prisma`, table `store_locations`):

| Field           | Notes                                             |
| --------------- | ------------------------------------------------- |
| `storeId`       | FK → `stores.id`, `ON DELETE CASCADE`             |
| `name`          | required; `nameAr?` Arabic                        |
| `country`       | required (e.g. "Egypt", "U.A.E."); `countryAr?`  |
| `address`       | required; `addressAr?`                            |
| `phone?`        | `tel:` target                                     |
| `whatsapp?`     | wa.me number (digits or `+<intl>`)                |
| `mapsUrl?`      | Google Maps search link (button target)           |
| `mapsEmbedUrl?` | optional `...&output=embed` iframe src            |
| `hours?`        | `hoursAr?` Arabic                                 |
| `isPublished`   | default `true` — public list shows only published |
| `position`      | sort order (asc), then `createdAt`                |

Index: `(store_id, is_published, position)`. **RLS:** direct `store_id` tenant policy
`rls_store_locations_tenant` + `FORCE ROW LEVEL SECURITY` (migration
`20260616120000_add_store_locations`). Reads/writes must run under the tenant GUC
(`runInTenantContext`) — admin routes set it via middleware; cross-tenant seeds run as
`neondb_owner` / `withRlsBypass`.

## Gating

`store.locationsEnabled` (BOOLEAN, default `false`) — a **Store column** (not a theme
flag) because the routes 404 when off. New-visual-feature default-OFF rule (UI rule #2).

## API

Mounted under `/api/v1` (`apps/api/src/routes/locations.routes.ts`):

- `GET    /stores/:storeId/locations` — admin list (`authenticate → authorize(store_admin, super_admin) → requireStoreAccess`)
- `POST   /stores/:storeId/locations` — create (+ `writeLimiter`)
- `PUT    /stores/:storeId/locations/:id` — store-scoped update (+ `writeLimiter`)
- `DELETE /stores/:storeId/locations/:id` — store-scoped delete (+ `writeLimiter`)
- `GET    /public/:storeId/locations` — public published list; **404 `LOCATIONS_DISABLED`** when `locationsEnabled` is false

Service: `apps/api/src/services/locations.service.ts` (`list / listPublished / create / update / remove`).
Updates/deletes are scoped by `{ id, storeId }` so a tenant can never touch another store's row by id.
Input validated by `locationInputSchema` (`@ebda/shared`) — `mapsUrl`/`mapsEmbedUrl` must be http(s) (anti-XSS).

## Admin

`/stores/[id]/locations` (apps/admin) — list + create/edit/delete + an **Enable Locations**
toggle (PUTs `store.locationsEnabled` via the store-update endpoint). Sidebar entry under the
**Settings** hub.

## Storefront

`apps/web/src/app/locations/page.tsx` — client component (mirrors the blog page): resolves the
store via `useStore()`, fetches `/public/:storeId/locations` via `api`, renders country-grouped,
theme-token-styled cards (map embed + Open-in-Maps / Call / WhatsApp pills), bilingual via
`useLanguage().t()` + `tx()`, RTL via `dir`. Returns a "not available" state on 404.
i18n strings live in `apps/web/src/contexts/LanguageContext.tsx`.

**Brand inheritance:** the component hardcodes zero colors — `bg-background/card/primary`,
`text-foreground/muted-foreground/primary-foreground`, `border-border`. Same page renders
pecan-brown for demo-store and each store's own palette for them.

**Discoverability:** when `locationsEnabled` is on, `ShopChrome` auto-appends a
bilingual **"Locations / الفروع"** item to the store's `navigation` list — which feeds
both the header nav and the footer across all 5 themes — so a visitor always has a
link to `/locations`. No manual config needed (it's skipped if the merchant already
added a `/locations` link via `store.settings.navMenu`). Merchants can still add
extra footer columns via `store.settings.footerLinks`. Requires the API to expose
`locationsEnabled` on the public store payload (`public.routes.ts`) and the web
`StoreContext` store type.

## Seed (demo-store)

`packages/database/scripts/seed-demo-store-locations.ts` — reads the captured
`~/Downloads/demo-store-migration/locations-page/locations.json`, upserts the branches by
`[storeId, name]` (idempotent), and sets `locationsEnabled=true`. Run post-deploy with the
prod `DATABASE_URL`:

```bash
npx tsx packages/database/scripts/seed-demo-store-locations.ts
```

Then verify on the storefront `/locations` (EN + AR) and in admin `/stores/<id>/locations`.

## Tests

- Unit: `tests/unit/location-schema.test.ts` (Zod + maps-URL validation/normalisation).
- Integration: `tests/integration/store-locations.test.ts` (CRUD + ordering + published filter +
  cross-store isolation against a real DB).
