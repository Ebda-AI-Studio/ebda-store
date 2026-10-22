# Dahab (دهب) — storefront template

> **Historical reference (2026-10-14).** Ruling TPL-2 retired the night/gold/arch skin described below. Dahab is now three looks in the looks registry — Worn (`dahab.worn`), Workshop (`dahab.workshop`), Gift box (`dahab.giftbox`) — see `docs/ebda/templates/looks.md`. The commerce wiring (ProductDetail, drawers, 3D slot) is reused; the visual language below is kept only as history until the old skin is deleted.

Builder Phase 3 pilot, 2026-10-07. Family `dahab` in `TEMPLATE_FAMILIES` (jewellery, handmade, premium gifts), with its own component skin (`stores.template = 'dahab'`). Status: **built for Ahmad's review; no other template is built until he approves the look** (preview: `https://dahab-preview.ebda.app`, admin `https://admin-preview.ebda.app`).

## Design

The scene: a Cairo goldsmith's vitrine at night — warm metal under low light, a velvet tray, an arched display window. Everything follows from that.

| Token                    | Value                  | Use                                                                                                      |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| Night (background)       | `222 29% 8%` · #0E1119 | page; a lapis-tinted night, not a generic near-black (gold on lapis is the Egyptian goldsmith's pairing) |
| Night, raised (card)     | `222 27% 11%`          | cards, panels, drawers                                                                                   |
| Night, alternate         | `223 28% 10%`          | alternate sections, footer, announcement                                                                 |
| Gold (primary)           | `39 49% 58%` · #C9A35E | prices, primary buttons, hairlines, active states                                                        |
| Bright gold (accent)     | `40 62% 70%` · #E2C285 | hover, focus ring                                                                                        |
| Ivory (foreground)       | `39 52% 90%` · #F2EADB | text                                                                                                     |
| Muted ivory              | `39 14% 68%`           | secondary text                                                                                           |
| Bronze hairline (border) | `38 24% 24%`           | dividers, outlines                                                                                       |

Every text pair the skin paints is checked for WCAG AA in `tests/unit/dahab-template.test.ts` (ivory/night 15:1, gold/night 8:1, night on gold buttons 8.6:1, muted on night ≥ 7:1).

Type: **Amiri 700** (classical Naskh, high contrast) for Arabic display, **Marcellus** (engraved-capital Roman) for Latin display — both calligraphy-rooted, so an Arabic and an English page share one voice. Body stays on the platform faces (IBM Plex Sans Arabic / Plus Jakarta Sans), so Dahab adds one font file per page. Display fonts load through `next/font` with `preload: false`: other stores never download them. Arabic is never letter-spaced (platform `:lang(ar)` reset); headings get Arabic line-heights (1.35–1.45).

The one bold idea is the **arch**: collection tiles and the image-with-text frame are vitrine/mihrab arches (`rounded-t-[999px]`); everything else is rectangular and quiet. One orchestrated motion: on first paint the hero's gold rule draws in and its copy rises (CSS only, off under reduced motion); everything else moves only in answer to the shopper (hover cross-fade to the second photo, drawers, accordions).

Radius `sm` (2px corners); buttons are solid gold (primary) or a gold hairline (secondary), 48px tall; numerals Western by default (`4,500 ج.م`), Arabic-Indic only on the store's opt-in (Ruling NUMERALS-1).

## What Dahab renders

Skin (`apps/web/src/templates/dahab/`): announcement bar, header (centred wordmark, inline-start navigation, search line, account, language, bag; phone menu drawer from the inline start, bag drawer from the inline end), hero banner + slideshow (art-directed mobile crop), product card (4:5, hover second photo on hover-capable pointers only, quick add, badges, Western-digit prices, sold-out state), product grid and carousel, collection tiles, testimonials, footer (link columns, contact, branches, socials, transparent payment marks), cart lines, order summary, empty state, form card, the bag drawer, and the product page (`ProductDetail.tsx`: gallery with hover zoom + full-screen viewer, metal swatches, quantity, add to bag, wishlist, `<details>` accordions for details / specifications / delivery / returns, pinned buy bar on phones, related carousel, `mediaSlot` for the 3D/AR viewer of PR #35).

Commerce logic is never duplicated: `ProductDetailClient` keeps pricing, variants, stock/backorder, add-to-cart and pixels and hands Dahab the results; the platform card (`templates/shared`) and carousel hand over to Dahab's when `pack === 'dahab'`; the collection page keeps its filters/sort and gains a 3/4-per-row density control on Dahab.

New builder sections (platform-level, every skin; `packages/shared/src/builder`): `featured-collection`, `collection-list`, `product-spotlight`, `trust-badges` — schemas, bilingual settings, presets, block validators, cross-store reference checks (`docs/architecture/page-definition.md`). `image-text` and `newsletter` get the Dahab look through CSS under `[data-pack='dahab']` (no markup change for other stores).

Defaults: `TEMPLATE_THEMES.dahab` (palette above, dividers off), `TEMPLATE_LAYOUT_BASELINES.dahab` (sections on the night page, no gold-flooded section blocks). The demo page composition is the seed's `homeDocument` (hero slideshow → collections → new in → craft image-with-text → gift ideas → necklaces → testimonials → trust badges → newsletter), saved and published through the page-builder service.

## Demo store

`scripts/dahab-demo/`: `catalogue.mjs` (22 pieces — rings, necklaces, bracelets, earrings — 18K/21K, EGP, Arabic + English copy, karat/size/length/colour variants), `seed-dahab.mjs` (owner, store, collections, catalogue through the admin bulk-import path, demo customers/orders/reviews, home document draft → publish), `fetch-photos.mjs` + `photos.json` (Unsplash photography, re-encoded to byte budgets; credits in `CREDITS.md`), `capture.mjs` (review screenshots). The store announces itself as a demo in its announcement bar.

```bash
# local: Postgres + Redis containers (Apple `container`), migrate, then
DATABASE_URL=<owner-role URL of the local container> OWNER_PASSWORD=… \
  npx tsx scripts/dahab-demo/seed-dahab.mjs            # loopback only unless --allow-remote
```

## Editor end to end (real stack)

`npm run test:editor-live` (with `EDITOR_E2E_PG=<local superuser postgres URL>`) drives the visual builder against the real admin, the real storefront in the canvas and the real API in workerd, over a fresh database seeded by this demo seed: edit a hero heading → live canvas, add + reorder a section, hide a section, publish → public storefront. Local only (Ruling EDITOR-LIVE-3).

## Preview stack

Isolated from production on every axis; production Workers, routes, Hyperdrive, queues, KV, R2 and the Neon `main` branch are untouched.

| Piece      | Preview                                                                                                                                                                                                                                            | Production (untouched)                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Database   | Neon branch `preview` (`br-blue-sky-b29b0j6o`), fresh database `ebda_preview` migrated from this branch; the copied `neondb` was dropped on the branch, so no production row exists in preview                                                     | `main` / `neondb`                                   |
| API        | Worker `ebda-api-preview` → `api-preview.ebda.app`, Hyperdrive `ebda-preview` (caching off, role `ebda_app`), KV `ebda-preview-cache`, queues `ebda-preview-{email,sms}[-dlq]`, rate-limit namespace 1101, no crons, own JWT/ENCRYPTION secrets    | `ebda-api`                                          |
| Storefront | Worker `ebda-web-preview` → `dahab-preview.ebda.app`, its own data cache (R2 `ebda-preview-isr-cache` + DO tag cache; edits appear within the fetch windows, ≤ 60 s for products/layout, 300 s for reviews — the preview has no revalidate secret) | `ebda-web` on `*.ebda.app/*` (`ebda-web-isr-cache`) |
| Admin      | Worker `ebda-admin-preview` → `admin-preview.ebda.app`                                                                                                                                                                                             | `ebda-admin`                                        |
| Media      | R2 `ebda-preview-media` (public r2.dev URL)                                                                                                                                                                                                        | `ebda-media`                                        |

`ebda-api-preview` has **no Workers AI binding** (`preview-config.mjs` drops the base config's `ai` block; Ruling SEARCH-T10-6): preview runs no Inngest indexer and keeps `SEARCH_SEMANTIC_ENABLED="false"`, so it logs `embedding provider: none` and search there is lexical only; a binding would bill any preview embed to the production account.

Smart placement was tried on `ebda-api-preview` and reverted: with it, about half of the requests waited the full 20 s for a pooled database client and answered 503 `OVERLOADED`; without it 28/28 probes answered 200. (2026-10-07: the same 20 s `OVERLOADED` came back without smart placement, from isolates whose database clients were all held by cancelled requests; fixed in `ClientPool`, see `docs/ebda/design/stage2-workers-db.md`, "Cancelled requests". The smart-placement result may have been the same leak.)

Each preview Worker is a custom domain **plus** a host-specific zone route (`<host>/*`): zone routes run before custom domains, so without it the production `*.ebda.app/*` route answered `api-preview.ebda.app` on the first deploy. Every preview response carries `X-Robots-Tag: noindex, nofollow` (`preview-worker` entries). No Resend / Inngest / Sentry / OneSignal / payment keys exist on preview: it cannot email, text or charge anyone. Secrets live in the macOS keychain (account `whisky11`): `ebda-preview-JWT_SECRET`, `ebda-preview-ENCRYPTION_KEY`, `ebda-preview-OWNER_DATABASE_URL`, `ebda-preview-APP_DATABASE_URL`, `ebda-preview-admin-login` (demo admin, `email password`).

Deploy (from a checkout of this branch, `CLOUDFLARE_ACCOUNT_ID=69188202efc4df480140dd76545aa3ab`):

```bash
PREVIEW_HYPERDRIVE_ID=9f87e8fb4ce549bc901a8d84c8827464 PREVIEW_KV_ID=060d12930dd84f3081a2b49feca405df \
  node scripts/preview/preview-config.mjs api
(cd apps/api && npx wrangler deploy --config .wrangler.preview.jsonc --secrets-file <json from keychain> --var BUILD_COMMIT_SHA:$(git rev-parse HEAD))
OPENNEXT_CACHE=true CF_SETUP_SKIP_DEPS=1 bash scripts/cf-setup-local.sh web && CF_SETUP_SKIP_DEPS=1 bash scripts/cf-setup-local.sh admin
STOREFRONT_FRAME_ANCESTORS=https://admin-preview.ebda.app NEXT_PUBLIC_API_URL=https://api-preview.ebda.app/api/v1 bash scripts/cf-build.sh web
NEXT_PUBLIC_API_URL=https://api-preview.ebda.app bash scripts/cf-build.sh admin
node scripts/preview/preview-config.mjs web && node scripts/preview/preview-config.mjs admin
(cd apps/web && npx wrangler deploy --config .wrangler.preview.jsonc)
(cd apps/admin && npx wrangler deploy --config .wrangler.preview.jsonc)
git checkout apps/web/wrangler.jsonc apps/web/open-next.config.ts apps/admin/wrangler.jsonc && rm -f apps/web/cache-worker-entry.ts   # generated files
```

Teardown (all preview-only names; nothing here touches production):

```bash
export CLOUDFLARE_ACCOUNT_ID=69188202efc4df480140dd76545aa3ab
npx wrangler delete --name ebda-web-preview      # run from an EMPTY directory (wrangler.jsonc account/name override)
npx wrangler delete --name ebda-admin-preview
npx wrangler delete --name ebda-api-preview
npx wrangler hyperdrive delete 9f87e8fb4ce549bc901a8d84c8827464
npx wrangler kv namespace delete --namespace-id 060d12930dd84f3081a2b49feca405df
for q in ebda-preview-email ebda-preview-sms ebda-preview-email-dlq ebda-preview-sms-dlq; do npx wrangler queues delete $q; done
npx wrangler r2 bucket delete ebda-preview-isr-cache   # empty it first if it holds cache objects
npx wrangler r2 bucket dev-url disable ebda-preview-media && npx wrangler r2 object delete … && npx wrangler r2 bucket delete ebda-preview-media
# Neon: delete ONLY the branch named `preview`
curl -X DELETE -H "Authorization: Bearer $(security find-generic-password -a whisky11 -s neon-api-key-whisky11 -w)" \
  https://console.neon.tech/api/v2/projects/lucky-truth-54548746/branches/br-blue-sky-b29b0j6o
for s in JWT_SECRET ENCRYPTION_KEY OWNER_DATABASE_URL APP_DATABASE_URL admin-login; do security delete-generic-password -a whisky11 -s ebda-preview-$s; done
```

Deleting a Worker removes its custom domain and zone route; verify afterwards that `https://<any>.ebda.app` still answers from `ebda-web`.

## Tests

- `tests/unit/dahab-template.test.ts` — new sections (registry, presets, section + block validation, unsafe links, refs), family, baseline vs the layout schema, theme contrast.
- `tests/unit/dahab-template-render.test.tsx` — render snapshots (Dahab + modern skin, ar + en; Dahab product page), Western digits, arch tiles, fallback suppression.
- `tests/integration/public-testimonials-rls.test.ts` — the testimonials route under strict RLS (bug found by this pilot).
- `tests/dahab/dahab-storefront.spec.ts` (`npx playwright test -c playwright.dahab.config.ts`) — home / collection / product / cart, ar + en, at 390 / 820 / 1440: direction, no horizontal scroll, Western digits, axe WCAG 2.1 AA (no serious/critical), drawers open from the correct side. Needs a seeded store; not in CI.
- Homepage characterization snapshots (5 legacy templates) are unchanged.

## Accepted payments

The footer and order summary share the cart's `AcceptedPaymentBadges` renderer. It reads fresh store-scoped `/payments/config` on mount/store changes; the stored `acceptedPaymentMethods` display override cannot enable a badge. Unknown, loading, failed or malformed configuration renders no payment claim. Only enabled method codes and configured COD/InstaPay appear, with Arabic/English labels. Checkout independently revalidates availability. No payment credentials or settings are changed by this display fix.

Regression evidence: `tests/unit/storefront-payment-badges.test.tsx` drives the real cart, Dahab footer and order summary, including stale card overrides, loading, network failure/retry, malformed config, method-specific labels and tenant switches/late responses. Initial15cases failed against the old renderers before correction.

> Gold-rate pricing (live price from today's gold rate) is a platform feature, not a Dahab one: it works on every template. The Dahab PDP shows its rate line under the price (`priceNote` slot). See `docs/architecture/gold-rate-pricing.md`.
