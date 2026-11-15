# Google Search Console — Indexing Guide for demo-merchant.com

_Last updated: 2026-05-28 | Applies to: demo-merchant.com GSC property + Ebda Store platform_

---

## TL;DR

Submit `sitemap.xml` to GSC for demo-merchant.com and verify `robots.txt` is reachable — those are the only two GSC actions that matter. Do **not** submit or noindex `llms.txt`; Google ignores it for search ranking and indexing it just clutters results. Add `Product` structured data monitoring in GSC Enhancements. Set up hreflang for EN/AR. Keep AI crawler directives in `robots.txt` only — no separate manifest needed.

---

## Answer-Engine Insights: GSC metrics ingestion (Plan 8B, added 2026-07-23)

Separate from the manual sitemap/robots.txt actions above, the platform now has an **automated daily GSC ingestion cron** (`gscIngestCron`, 04:00 UTC) that pulls each active store's Search Analytics (impressions, clicks, CTR, average position, top queries) into `GscDailyMetric` rows, surfaced on the merchant-facing `/stores/:id/answer-engine` dashboard's GSC section alongside the AEO/GEO citation-check data.

This is **force-managed, not a per-merchant credential** — a single Google Cloud service account is granted read access to every Force-owned GSC property, not a client's own Search Console login. It is **dormant** (cron no-ops, zero rows, dashboard shows "Google Search Console not connected") until go-live:

1. Create a Force Google Cloud service account (Google Cloud Console → IAM & Admin → Service Accounts), download its JSON key.
2. In each merchant's GSC property → **Settings → Users and permissions → Add user**, add the service account's `client_email` as a **Restricted** (read-only) user. Repeat per property — the ingestion cron tries both the `sc-domain:` and `https://.../` property URL forms per store domain (see `gsc-client.ts`).
3. Set `GSC_SERVICE_ACCOUNT_JSON` (the full downloaded key JSON, one line) in the API's production env — see `docs/ENVIRONMENT.md` for the exact var and dormancy behavior.
4. Live-smoke ONE real property first (check `GscDailyMetric` rows land with non-zero impressions on a known-indexed domain) before relying on the data platform-wide — GSC data typically lags 2-3 days, so a freshly-added property may read thin for the first few days.

### Which property does a store use? (2026-11-15)

- `<slug>.ebda.app`: the platform property `sc-domain:ebda.app` (service account `ebda-gsc@ebda-search.iam.gserviceaccount.com`, siteFullUser). Search Analytics is queried with a `page contains https://<slug>.ebda.app/` filter so a store only sees its own rows.
- Custom domain: the daily cron verifies it automatically (service account gets a META token from the Site Verification API, it is stored in `Store.googleSiteVerification` and rendered by the storefront, then `sites.add` registers `https://<domain>/`). Prerequisite: Site Verification API enabled in project `ebda-search`. Log lines: `gsc-ingest: custom-domain property check` with `status` = `verified | verify_failed | token_failed | sites_add_failed | merchant_token`.
- `merchant_token`: the merchant already pasted their OWN token (verified in their own Search Console). We never overwrite it; the merchant adds `ebda-gsc@ebda-search.iam.gserviceaccount.com` as a user (Settings, Users and permissions, Restricted) instead, and the next run finds the property.
- The merchant sees "Verifying your domain with Google" in the answer-engine GSC section until the property is visible.

No changes to the sitemap/robots.txt/structured-data guidance above are needed for this — it is a read-only Search Analytics pull, not an indexing action.

---

## Per-file GSC action table

| File / URL                         | GSC action needed?            | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sitemap.xml`                      | **Yes — required**            | Add property for `https://demo-merchant.com` → Sitemaps → submit `https://demo-merchant.com/sitemap.xml`. Re-submit after bulk product adds or domain changes.                                                                                                                                                                                                                                                                                                          |
| `robots.txt`                       | **Yes — verify reachability** | GSC → Settings → Robots.txt tester. Confirm Google can fetch `https://demo-merchant.com/robots.txt` and that no key paths are wrongly blocked.                                                                                                                                                                                                                                                                                                                          |
| `llms.txt`                         | **No GSC action**             | Google does not use `llms.txt` for search ranking or indexing (confirmed by Gary Illyes + John Mueller, 2025). It is useful for Anthropic Claude retrieval only. Do NOT submit it to GSC. Do NOT add a `noindex` meta tag to it — just leave it alone and let it serve AI agents that request it. If it ever appears in Google search results as a standalone result (unlikely but possible if linked), then apply `X-Robots-Tag: noindex` in the HTTP response header. |
| Structured data (JSON-LD)          | **Monitor — required**        | GSC → Enhancements → Shopping (or "Product snippets"). Fix any `price`, `availability`, or `image` errors flagged there. These directly affect rich results in Google Shopping.                                                                                                                                                                                                                                                                                         |
| `robots.txt` AI-crawler directives | **No GSC action**             | Managed in `apps/web/src/app/robots.ts`. See AI crawler section below.                                                                                                                                                                                                                                                                                                                                                                                                  |

> **Why the sitemap is already correct:** `apps/web/src/app/sitemap.ts` is host-aware — on `demo-merchant.com` it emits only Wady Aljuz's URLs rooted at `https://demo-merchant.com`, not platform URLs. This was fixed 2026-05-14. The submitted sitemap will not bleed `store.ebda.app` paths into the merchant's GSC property.

> **Sitemap coverage limits (2026-09-02, audit-followup #1146/#1147/#1148):**
> operators reading a GSC coverage drop should know these bounds before
> suspecting a crawl bug.
>
> - **Per-store product URLs are paginated, not unlimited.** The API clamps
>   `/public/products` at 100/page; the sitemap now pages through the catalog —
>   up to **1,000 products** on a merchant's own custom-domain sitemap (10
>   pages) and up to **300 products per store** in the master sitemap (3
>   pages). Truncation past those bounds logs
>   `sitemap: product pagination capped for store` in Worker logs.
> - **Master-sitemap product fan-out covers at most 200 stores**, selected
>   **oldest-first** (longest-tenured/anchor tenants keep their catalogs;
>   the newest stores past the cap contribute their 11 static pages only).
>   The drop logs `sitemap: product fan-out capped`.
> - **The master sitemap hard-clamps at 50,000 URLs** (sitemaps.org protocol
>   limit — Google rejects/truncates anything larger). Hitting the clamp logs
>   `sitemap: master sitemap exceeds the 50k-URL protocol limit`, with
>   `storesFullyDropped`, `storesWithNoCatalogUrls`, `storesNeverFetched` and
>   `catalogUrlsDropped` in the payload (2026-09-25, #1821: `storesWithNoCatalogUrls`
>   is new — see why below; #1815: `storesNeverFetched` — see the next bullet).
> - **The store list itself can come back short, and now says so (2026-09-25,
>   #1815).** `fetchStores()` stops at 50 pages (5,000 stores) and logs
>   `sitemap: store list page ceiling hit`; a non-2xx page mid-pagination logs
>   `sitemap: store list fetch failed mid-pagination`. Both used to be silent,
>   so the clamp's `storesFullyDropped` undercounted — its payload now also
>   carries `storesNeverFetched`. A store whose product fan-out throws keeps
>   its static pages and is counted in
>   `sitemap: product fan-out failed for some stores — static pages only`.
> - **The platform root is not in the master sitemap (2026-09-25, #1543).**
>   `store.ebda.app/` 307s to `ebda.app`; GSC would report it as "Page
>   with redirect". Per-store roots (`/<slug>`) are listed as before.
> - **What the clamp drops, and in what order.** Every store's 11 static pages
>   are emitted FIRST, in one bounded pass, for EVERY store — including the
>   eight low-value ones (`/privacy`, `/terms`, `/faq`, `/shipping`,
>   `/returns`, `/about`, `/contact`, `/how-to-guides`); product and bundle
>   URLs are appended after, for ALL stores, only once every store's static
>   pages are in. So product-URL coverage is `max(0, 50,000 -
11 × storeCount)` (no apex term since #1543 dropped the platform root) — at ~4,545 stores that reaches **zero before any store
>   loses even its static pages**, which is the metric `storesFullyDropped`
>   reports. **Catalog coverage degrades far earlier than that** (#1821/#1828,
>   corrected 2026-09-25): `MAX_STORES_WITH_PRODUCTS=200` x
>   `PRODUCT_PAGES_PER_STORE=3` (up to 300 product URLs/store) can produce up
>   to 60,000 catalog URLs from the 200 anchor tenants alone, so once catalog
>   depth is in play a product-bearing store can lose its ENTIRE catalog
>   contribution — zero product/bundle URLs, still-present static pages —
>   at roughly the 160th product-bearing store, some 28x below the
>   ~4,500-store threshold that used to be the only trigger named here.
>   `storesFullyDropped` stays 0 through all of this, because it only counts a
>   store whose static pages are gone too; watch `storesWithNoCatalogUrls` (and
>   `catalogUrlsDropped`) for the earlier, catalog-only failure.
>
>   Static-pages-first was NOT true before 2026-09-13. The list was built
>   store-by-store and the clamp cut the tail, so ~161 full-catalog stores
>   (11 + 300 URLs each) consumed the entire budget and every store after them
>   was emitted with ZERO URLs — vanishing from the master sitemap outright
>   rather than degrading to static-page-only coverage. Measured on the
>   pre-fix code: 400 stores with full catalogs, **239 of them emitted
>   nothing**. If you are reading a Worker log from before that date, `total`
>   alone did not tell you any store had been dropped.
>
> - Two thresholds, not one: **catalog coverage degrades from roughly 160
>   full-catalog stores** (watch `catalogUrlsDropped` /
>   `storesWithNoCatalogUrls`); **static-page coverage only degrades past
>   ~4,500 stores** (watch `storesFullyDropped`). Sharding is the fix for
>   the first threshold, not just the second — but NOT via Next's
>   `generateSitemaps()`, which remaps the route to `/sitemap/[id].xml`
>   and 404s the bare `/sitemap.xml` every merchant has already submitted.
> - Merchant custom-domain sitemaps are unaffected by the store cap and the
>   50k clamp (11 static pages + ≤1,000 products).
> - **An API outage now 5xxs the sitemap instead of emptying it (2026-10-01,
>   #2127).** A 200 with an empty `<urlset/>` made GSC record "0 discovered
>   URLs" and replace its last-good state; a 5xx makes Google retry and keep
>   the previous copy. The render THROWS (`sitemap source unavailable: …`) when
>   the store list's page 1 fails or the fetch throws, when a custom-domain
>   host resolve fails with anything but a 404 (previously it silently fell
>   through to the PLATFORM sitemap on the merchant's domain), and when a
>   custom-domain sitemap's products page 1 fails. Worker logs carry
>   `sitemap: store list unavailable — failing the render (5xx)`. **An empty
>   200 sitemap is now only ever a genuine "zero stores" answer** — if GSC
>   reports one, that is alertable, not an outage. A master-sitemap store whose
>   own product fan-out fails still degrades to static pages (counted, above).

---

## AI crawler directives (robots.txt)

The current `robots.ts` uses a single wildcard rule (`User-agent: *`, `Allow: /`) which applies to all bots including AI crawlers. In 2026 the recommended ecommerce strategy is:

**Allow** (drives citation traffic from AI-powered search and chat):

- `Google-Extended` — Gemini AI answers, Google SGE
- `OAI-SearchBot` / `ChatGPT-User` — ChatGPT Browse with Bing integration
- `Claude-SearchBot` / `Claude-User` — Claude.ai user-triggered retrieval (distinct from training crawl)
- `PerplexityBot` — Perplexity AI answers

**Block for training, allow for retrieval** (nuanced — see note):

- `GPTBot` — OpenAI training scraper. Blocking does not affect ChatGPT search answers. Low referral value; primarily bandwidth cost.
- `ClaudeBot` — Anthropic training scraper (separate from `Claude-SearchBot`). Same trade-off.

**The simple rule for a Egypt ecommerce store**: if being cited in AI answers matters (it does for discovery), keep the wildcard `Allow: /` as-is for public catalog pages. The current `robots.ts` already disallows `/account/`, `/checkout/`, `/cart/`, `/auth/`, and `/affiliate/` which is correct for all bots.

**To add explicit AI-crawler control**, update `apps/web/src/app/robots.ts` rules array:

```ts
rules: [
  {
    userAgent: '*',
    allow: '/',
    disallow: ['/account/', '/checkout/', '/cart/', '/auth/', '/affiliate/'],
  },
  // Optional: block pure training scrapers (does NOT affect AI search answers)
  {
    userAgent: ['GPTBot', 'ClaudeBot', 'CCBot', 'Amazonbot', 'Bytespider'],
    disallow: ['/'],
  },
  // Explicitly allow retrieval agents (redundant with wildcard but makes intent clear)
  {
    userAgent: ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Google-Extended'],
    allow: ['/'],
    disallow: ['/account/', '/checkout/', '/cart/', '/auth/', '/affiliate/'],
  },
],
```

> **Note:** As of 2026, many training scrapers ignore `robots.txt` or spoof User-Agents. `robots.txt` directives are a policy declaration, not enforcement. For real blocking, use Cloudflare WAF rate-limiting by IP range.

---

## Bilingual SEO (EN/AR) — hreflang

demo-merchant.com serves bilingual content (Arabic default + English toggle) but currently does so via a client-side language context (`LanguageContext.tsx`) without separate URL paths (e.g. `/en/` vs `/ar/`). This means:

**Current state:** No hreflang tags because there are no separate locale URLs. Google indexes one URL per page and guesses the language from page content.

**Recommended approach (low-effort, correct for now):**

1. In `generateMetadata()` for each page type (PDP, PLP, homepage), set `alternates.languages` only if you add locale URL prefixes. Without distinct URLs, hreflang provides no benefit — do not add it as a no-op.
2. Set `lang="ar"` on `<html>` when the store's default language is Arabic. This is the single most impactful signal. Check `apps/web/src/app/layout.tsx` to verify it reads from store config.
3. In GSC → Settings → International Targeting, set the geographic target to **Egypt (KW)** for the demo-merchant.com property. This is a soft signal but costs nothing.

**If locale URLs are added later** (e.g. `demo-merchant.com/en/` and `demo-merchant.com/ar/`):

- Add `alternates.languages` in `generateMetadata()`:
  ```ts
  alternates: {
    languages: {
      'ar': 'https://demo-merchant.com/ar/...',
      'en': 'https://demo-merchant.com/en/...',
      'x-default': 'https://demo-merchant.com/ar/...',
    }
  }
  ```
- Register both locale properties in GSC (`/ar/` prefix variant and root) or use a single domain property.

---

## Ecommerce-specific GSC actions

### Structured data monitoring (highest priority)

GSC Enhancements reports catch `Product` schema errors before they silently cost rich results.

1. **GSC → Enhancements → Shopping** — check for missing `price`, `priceCurrency`, `availability`, or `image` on product pages. The `structured-data.ts` `productJsonLd()` already emits all required fields; errors here usually mean a product has no image or the price is zero.
2. **Rich Results Test** (`https://search.google.com/test/rich-results`) — spot-check a PDP URL (e.g. `https://demo-merchant.com/products/<slug>`) to confirm `Product` JSON-LD renders correctly.
3. **`X-Robots-Tag` confirmation** — no product page should emit `noindex`. The current setup doesn't, but confirm after any middleware change.

### Google Merchant Center (separate from GSC)

For Google Shopping product listings (paid + free), connect `demo-merchant.com` to **Google Merchant Center** (not GSC). The existing `Product` JSON-LD feeds into free product listings automatically once the domain is verified in Merchant Center. This is separate from, but complementary to, GSC.

### Coverage report — check after sitemap submission

After submitting the sitemap, GSC → Indexing → Pages will show:

- **Indexed** count should grow over ~1-2 weeks
- **Excluded: Duplicate without canonical** — check if `store.ebda.app/wady-aljuz/...` URLs appear here (means old platform paths are competing with the custom domain)
- **Crawled, not indexed** — check for thin-content product pages

---

## Renamed-slug 308 self-redirects (2026-07-22)

Product and blog handle renames no longer produce a soft-404 or a hard miss that
drops link equity. When a merchant renames a product handle or a blog post slug
(directly, via bulk/xlsx import, or via the admin), the API records the old →
new slug in the `SlugRedirect` table (Postgres, FORCE-RLS). The storefront
resolves a miss on `/products/[slug]` or `/blog/[slug]` against
`GET /public/redirects/resolve?type=product|blog&slug=<old>` and, on a hit,
issues a real HTTP **308** (`permanentRedirect`) to the current URL — not a
client-side bounce, not a 200 with stale content.

The category filter (`/products?category=<slug>`) behaves the same way: a
renamed category slug in the `?category=` query 308s to the current slug via
the same resolve endpoint (`type=category`).

**Genuine misses now hard-404.** Before this change, a real store with no
matching product/blog record silently rendered a null-content page (soft-404 —
invisible to Search Console as an error, but useless to users and to Google).
That soft-404 path is removed: a slug with no product/post AND no redirect row
now returns a real `notFound()` (404), which is what GSC's Coverage report
should show for those URLs — check "Not found (404)" there, not "Indexed"
or "Crawled, not indexed", after a rename.

**Pages are excluded.** CMS `StorePage` rows have no rename path today (they're
looked up by their current slug only, with no update-triggered capture), so
there is no redirect table entry to check for a renamed CMS page. If a page
slug does change, treat it as a manual 301 (Cloudflare rule) — the same as
before this feature shipped.

Architecture + capture points: `docs/architecture/slug-redirects.md`.

---

## What NOT to do

- Do not submit `llms.txt` to GSC. Google confirmed it doesn't use it for search.
- Do not submit `robots.txt` as a sitemap — it's not a sitemap.
- Do not add `<link rel="sitemap">` for `llms.txt` — not a crawlable document format for Google.
- Do not add hreflang tags when there are no separate locale URL paths — it is invalid and causes GSC errors.
- Do not set geographic target to "Saudi Arabia" or "All regions" for the demo-merchant.com property — Egypt targeting is the correct choice.

---

## References

- [Google Search Central: Build and Submit a Sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google Search Central: Structured Data for Ecommerce](https://developers.google.com/search/docs/specialty/ecommerce/include-structured-data-relevant-to-ecommerce)
- [Google's llms.txt guidance (SearchEngineJournal, 2025)](https://www.searchenginejournal.com/googles-llms-txt-guidance-depends-on-which-product-you-ask/575431/)
- [Anthropic Claude bots framework — ClaudeBot vs Claude-SearchBot](https://almcorp.com/blog/anthropic-claude-bots-robots-txt-strategy/)

---

## Keeping a store out of search while it is being prepared

Admin: Store settings, SEO, "Hide my store from search engines" (Ruling SEO-HIDE-1, `docs/rulings/SEO-HIDE-1.md`). On: `noindex, nofollow` on every page, empty `sitemap.xml`, no sitemap line in `robots.txt`, `llms.txt` 404. Do not add a `Disallow: /` by hand: crawlers must be able to read the `noindex` meta. Turn it off at launch, then submit the sitemap in Search Console.
