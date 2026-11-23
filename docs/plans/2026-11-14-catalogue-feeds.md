# Product catalogue feeds: Google, Meta, TikTok (2026-11-14)

Rulings: `docs/rulings/FEEDS.md`. Notes: `~/.claude/handoff/5e88127d-94f8-40b5-995e-bb643ebde0a1-feeds.md`.
Ahmad 2026-11-14: "fix all the gaps and make all work google, meta, tiktok".

## Finish line

- **Must work:** a merchant copies one link per platform from the admin page "Product feeds" and Google Merchant Center, Meta Commerce Manager and TikTok Catalog Manager can read the WHOLE catalogue (not 100 products), one item per purchasable variant, with price, sale price, availability, brand, gtin-or-identifier_exists=no, category, images, link to the merchant's real domain, in Arabic (default) or English.
- **Flows exercised:** `GET /public/feed/google.xml|meta.xml|tiktok.csv?lang=ar|en&part=N` (feature on, feature off, bad params, part past the end); builder over fixtures (variants, sale, out of stock, backorder, invalid barcode, Arabic, `& < >`); pagination over 250 products and over a 5200-item catalogue (two parts); a price change followed by `invalidateStoreProductCaches`; the id contract across feed / pixel / CAPI / Ebda Chat bridge; the admin page (loading, error, empty, healthy, with issues).
- **Must NOT change:** `GET /public/feed/products.json` (the AI feed, `agent_feed`) and its byte output; tenant isolation (store from host, 404 when the feature is off); the storefront's pixel events for simple products (same ids as before); order creation (CAPI stays fail-open and value-only when an order has no lines).
- **Done =** `tsc` 0 in api, web, admin, shared; the new tests green and red when the thing they guard is broken (one mutation check per key test, recorded below); a generated feed has zero violations in the local Google-rules validator; docs parity (feature matrix, merchant guide, API docs, plans index, ruling file); PR open, not merged.

## Verified external specs (read 2026-11-14)

- **Google Merchant Center product data specification** (support.google.com/merchants/answer/7052112): required `id` (<=50, stable), `title` (<=150), `description` (<=5000), `link`, `image_link`, `availability` (`in_stock|out_of_stock|preorder|backorder`), `price` (`15.00 USD`), `brand` (<=70; required for new products), `condition` (optional when new); `gtin` digits only with GS1 checksum, `mpn` only when no manufacturer GTIN, `identifier_exists=no` only when identifiers truly do not exist; `item_group_id` required for variants in free listings; `color/size/gender/age_group` required for apparel on free listings; `sale_price` + `sale_price_effective_date` (`start/end`, ISO 8601); `google_product_category` numeric id or path. Images: from 2027-01-31 at least 500x500. The page's RSS/`g:` section and `shipping`/`shipping_weight` fell outside what could be read; those follow the long-standing RSS 2.0 + `xmlns:g="http://base.google.com/ns/1.0"` shape and `<g:shipping><g:country/><g:price/></g:shipping>`.
- **Meta catalog data feed** (developers.facebook.com/docs/marketing-api/catalog/reference): required `id` (<=100, "for dynamic ads it must exactly match the content ID in your Meta Pixel"), `availability` (`in stock|out of stock`), `condition`, `price` (`9.99 USD`), `link` (on your own domain), `image_link` (>=500x500, <=8 MB), `brand`; `item_group_id` for variants; at least one of brand/gtin/mpn; `google_product_category` or `fb_product_category`. **Formats: CSV, TSV, RSS XML, Atom XML, Google Sheets; the Google `g:` namespace in RSS 2.0 XML is supported.** Pixel: `content_type` is `product` for item ids and `product_group` for group ids; omitted = matches either (developers.facebook.com/docs/meta-pixel/reference).
- **TikTok catalog parameters** (ads.tiktok.com/help/article/catalog-product-parameters): required `sku_id` (not `id`; duplicate ids are ignored), `title`, `description`, `availability` (`in stock|available for order|preorder|out of stock|discontinued`), `condition`, `price`, `link`, `image_link` (JPG/PNG), `brand`; `item_group_id` for variants; `google_product_category` three levels at most. Accepted file formats (CSV, XML RSS, XML Atom, ZIP, GZ) from TikTok's own help centre as quoted by a search, not read directly; whether TikTok accepts Google `g:` tags was NOT confirmed. Ruling FEEDS-3: TikTok gets its own CSV with its own column names.

## Design

### Endpoints (all under `/public/feed/`, mirrored by the storefront at `/feeds/`)

| Platform               | Path                       | Wire format |
| ---------------------- | -------------------------- | ----------- | ---------------------------------------- |
| Google Merchant Center | `/feeds/google.xml?lang=ar | en&part=N`  | RSS 2.0 + `g:`                           |
| Meta Commerce Manager  | `/feeds/meta.xml?lang=ar   | en&part=N`  | RSS 2.0 + `g:` (Meta availability words) |
| TikTok Catalog Manager | `/feeds/tiktok.csv?lang=ar | en&part=N`  | CSV, `sku_id`                            |

`products.json` stays as it is. The storefront route (`apps/web/src/lib/catalogue-feed-route.ts`) resolves the host, forwards validated `lang`/`part`, and moves the store's own links onto the language prefix when LOCALE-PATHS is on (an English feed links to `/en/...`). 404 in every not-available case; 503 + no-store when the API cannot be asked.

### One item id (Ruling FEEDS-2)

`catalogueItemId({ productId, variantId })` in `packages/shared/src/commerce/catalogue-item-id.ts`: simple product = product id; one variant of a variant product = **variant id**; bundle = bundle id; `item_group_id` = product id. Uuids, stable for the life of the row. It is the id of: the feed `id`/`sku_id`; Meta/TikTok pixel `content_ids` (ViewContent on a variant product is `content_type: product_group` with the product id, AddToCart is the chosen variant, InitiateCheckout/Purchase use the cart/order lines); the server-side CAPI Purchase `content_ids`/`contents` (Meta) and `contents` (TikTok), now sent with the order lines; and Ebda Chat's store bridge `retailerId` (`apps/api/src/lib/wa/bridge/do-port.ts`), which already used this shape and now calls the function. Contract test: `tests/unit/catalogue-item-id-contract.test.ts` (feed, CAPI, and a source-level pin of the bridge and every pixel call site). Before this change the pixel sent the PRODUCT id for variants and Purchase sent product ids, so dynamic retargeting could not match a variant feed.

### Full catalogue, parts, cache (Ruling FEEDS-4)

Products are read in keyset pages (`id > cursor`, 100 per page, never OFFSET) and rendered chunk by chunk. A file holds `PART_ITEMS` = 5000 items, ending on a product boundary; `?part=N` selects the file, `X-Feed-Next-Part` says another exists, the admin page tells the merchant to add each part as its own source. Cached part: `public:products:<storeId>:feedx:v1:<platform>:<lang>:bo<0|1>:<part>` (TTL 600). That prefix is dropped by `clearProductsRedis` on EVERY product, variant, price, stock, category, bundle and order write path (the `invalidate*` functions already called everywhere), so the KV/Redis layer is NEVER-stale. The `inventory.backorder` entitlement is in the key. Bundles are applied per request (their sale window is not a write). The edge/CDN copy cannot be purged off a platform's own cache, so it is BOUNDED-stale: `s-maxage=300`, no stale-while-revalidate, 60 s for a store that sells gold-rate products; the storefront's data cache entry carries the `products:<storeId>` tag, purged on every write. Platforms fetch hourly at the shortest, so the window is shorter than their interval (inferred, not measured).

### Fields

id, title (language specific, AR default, variant appended), description (plain text, falls back to excerpt then title, flagged), link, image_link + up to 10 additional, availability (in_stock / out_of_stock / backorder from variant-aware stock and the store's backorder entitlement; no `preorder`: there is no availability date in the data), price (regular) + sale_price (storefront rule: a simple product's compare-at; a variant's OWN compare-at, the parent's is ignored), brand (a `Brand` product fact, else the store name in the feed language), gtin (only if it passes the GS1 checksum, variants never inherit the parent's code) else mpn (an `MPN` fact) else `identifier_exists=no`, condition new, google_product_category (whole-word match on the product's category chain via a verified table; a `google_product_category` fact pins an id; no match = omitted, never guessed), product_type (breadcrumb), color/size/material/gender/age_group (option values and facts, EN + AR option names), shipping_weight (kg to g), `shipping` (only when every active delivery rate is the same). Excluded and reported in health: no image, zero price, inactive variant, no title (drafts, archived, soft-deleted and wholesale-only never enter the feed and are counted). XML: every text escaped and XML-1.0-illegal characters stripped. CSV: RFC 4180, every field quoted, leading `= + - @` neutralised.

### Gating (Ruling FEEDS-1)

New feature key `product_feeds`, in `STARTER_CORE`: every paid plan, off on `free`: the same gate as `agent_feed` and `marketing_pixels`. A separate key (not reusing `agent_feed`) so a super-admin override on one cannot switch off the other. Routes fail closed: public 404, merchant API 403 `FEATURE_DISABLED`.

### Admin (`apps/admin/src/app/stores/[id]/product-feeds`)

Marketing hub tab "Product feeds". Three platform cards (links per language with copy, collapsible setup steps), a language switch, and the health panel (counts, parts notice, not-published counts, shipping note, per-item exclusions and warnings with the fix). Loading skeleton, error with retry, empty state, healthy state. Arabic Egyptian full sentences, English twin, no orange. API: `GET /stores/:storeId/product-feeds/health?lang=` (`products:read`, store access, feature gate), cached 120 s under `admin:products:<storeId>:` (also cleared on every product write).

### Cleanup

Removed the orphan comment "Phase A: product to Meta Catalog sync" in `apps/api/src/lib/inngest/functions/index.ts` and the `metaCatalogCard` i18n keys (en + ar): grep over `apps/`, `packages/` and `ebda-whatsapp` found no reference; provisioning lives in Ebda Chat.

## Not verified / known gaps

- No real Merchant Center, Commerce Manager or Catalog Manager fetch (needs a merchant account and a live store); the local validator encodes the Google spec but is not Google's.
- Image dimensions are not measured (platforms want 500x500); the admin page says so.
- `link` is the product page for every variant: the PDP has no `?variant=` preselect yet (follow-up; accepted by the platforms, less precise for ads).
- TikTok optional columns beyond the documented required set are best effort.
- Variant `gender`/`age_group` exist only if the merchant adds them (option or fact); apparel items without them are flagged, not invented.

## Evidence

- Mutation checks (2026-11-14): moving the cached part's key out of the `public:products:<storeId>:` prefix makes `catalogue-feed-service.test.ts` fail (price-change and backorder-key tests); making `catalogueItemId` ignore the variant makes `catalogue-item-id.test.ts` fail. Both restored.
- Local gate: new + related suites green (feed builder/validator, routes, pagination, cache invalidation, id contract, web passthrough, plan baselines, ssr-client-ip classification, admin hub/i18n/settings, pixels-capi, wa-bridge); `tsc` 0 in api, web, admin, shared. The FULL local suite was NOT run (host lock held by CI for hours); the PR's CI is the full run.
