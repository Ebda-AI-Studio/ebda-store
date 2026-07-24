# Google Search Console — Indexing Guide for wadyaljuz.com

_Last updated: 2026-05-28 | Applies to: wadyaljuz.com GSC property + Force AI Store platform_

---

## TL;DR

Submit `sitemap.xml` to GSC for wadyaljuz.com and verify `robots.txt` is reachable — those are the only two GSC actions that matter. Do **not** submit or noindex `llms.txt`; Google ignores it for search ranking and indexing it just clutters results. Add `Product` structured data monitoring in GSC Enhancements. Set up hreflang for EN/AR. Keep AI crawler directives in `robots.txt` only — no separate manifest needed.

---

## Answer-Engine Insights: GSC metrics ingestion (Plan 8B, added 2026-07-23)

Separate from the manual sitemap/robots.txt actions above, the platform now has an **automated daily GSC ingestion cron** (`gscIngestCron`, 04:00 UTC) that pulls each active store's Search Analytics (impressions, clicks, CTR, average position, top queries) into `GscDailyMetric` rows, surfaced on the merchant-facing `/stores/:id/answer-engine` dashboard's GSC section alongside the AEO/GEO citation-check data.

This is **force-managed, not a per-merchant credential** — a single Google Cloud service account is granted read access to every Force-owned GSC property, not a client's own Search Console login. It is **dormant** (cron no-ops, zero rows, dashboard shows "Google Search Console not connected") until go-live:

1. Create a Force Google Cloud service account (Google Cloud Console → IAM & Admin → Service Accounts), download its JSON key.
2. In each merchant's GSC property → **Settings → Users and permissions → Add user**, add the service account's `client_email` as a **Restricted** (read-only) user. Repeat per property — the ingestion cron tries both the `sc-domain:` and `https://.../` property URL forms per store domain (see `gsc-client.ts`).
3. Set `GSC_SERVICE_ACCOUNT_JSON` (the full downloaded key JSON, one line) in the API's production env — see `docs/ENVIRONMENT.md` for the exact var and dormancy behavior.
4. Live-smoke ONE real property first (check `GscDailyMetric` rows land with non-zero impressions on a known-indexed domain) before relying on the data platform-wide — GSC data typically lags 2-3 days, so a freshly-added property may read thin for the first few days.

No changes to the sitemap/robots.txt/structured-data guidance above are needed for this — it is a read-only Search Analytics pull, not an indexing action.

---

## Per-file GSC action table

| File / URL                         | GSC action needed?            | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sitemap.xml`                      | **Yes — required**            | Add property for `https://wadyaljuz.com` → Sitemaps → submit `https://wadyaljuz.com/sitemap.xml`. Re-submit after bulk product adds or domain changes.                                                                                                                                                                                                                                                                                                                  |
| `robots.txt`                       | **Yes — verify reachability** | GSC → Settings → Robots.txt tester. Confirm Google can fetch `https://wadyaljuz.com/robots.txt` and that no key paths are wrongly blocked.                                                                                                                                                                                                                                                                                                                              |
| `llms.txt`                         | **No GSC action**             | Google does not use `llms.txt` for search ranking or indexing (confirmed by Gary Illyes + John Mueller, 2025). It is useful for Anthropic Claude retrieval only. Do NOT submit it to GSC. Do NOT add a `noindex` meta tag to it — just leave it alone and let it serve AI agents that request it. If it ever appears in Google search results as a standalone result (unlikely but possible if linked), then apply `X-Robots-Tag: noindex` in the HTTP response header. |
| Structured data (JSON-LD)          | **Monitor — required**        | GSC → Enhancements → Shopping (or "Product snippets"). Fix any `price`, `availability`, or `image` errors flagged there. These directly affect rich results in Google Shopping.                                                                                                                                                                                                                                                                                         |
| `robots.txt` AI-crawler directives | **No GSC action**             | Managed in `apps/web/src/app/robots.ts`. See AI crawler section below.                                                                                                                                                                                                                                                                                                                                                                                                  |

> **Why the sitemap is already correct:** `apps/web/src/app/sitemap.ts` is host-aware — on `wadyaljuz.com` it emits only Wady Aljuz's URLs rooted at `https://wadyaljuz.com`, not platform URLs. This was fixed 2026-05-14. The submitted sitemap will not bleed `store.forcemediakw.com` paths into the merchant's GSC property.

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

**The simple rule for a Kuwait ecommerce store**: if being cited in AI answers matters (it does for discovery), keep the wildcard `Allow: /` as-is for public catalog pages. The current `robots.ts` already disallows `/account/`, `/checkout/`, `/cart/`, `/auth/`, and `/affiliate/` which is correct for all bots.

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

wadyaljuz.com serves bilingual content (Arabic default + English toggle) but currently does so via a client-side language context (`LanguageContext.tsx`) without separate URL paths (e.g. `/en/` vs `/ar/`). This means:

**Current state:** No hreflang tags because there are no separate locale URLs. Google indexes one URL per page and guesses the language from page content.

**Recommended approach (low-effort, correct for now):**

1. In `generateMetadata()` for each page type (PDP, PLP, homepage), set `alternates.languages` only if you add locale URL prefixes. Without distinct URLs, hreflang provides no benefit — do not add it as a no-op.
2. Set `lang="ar"` on `<html>` when the store's default language is Arabic. This is the single most impactful signal. Check `apps/web/src/app/layout.tsx` to verify it reads from store config.
3. In GSC → Settings → International Targeting, set the geographic target to **Kuwait (KW)** for the wadyaljuz.com property. This is a soft signal but costs nothing.

**If locale URLs are added later** (e.g. `wadyaljuz.com/en/` and `wadyaljuz.com/ar/`):

- Add `alternates.languages` in `generateMetadata()`:
  ```ts
  alternates: {
    languages: {
      'ar': 'https://wadyaljuz.com/ar/...',
      'en': 'https://wadyaljuz.com/en/...',
      'x-default': 'https://wadyaljuz.com/ar/...',
    }
  }
  ```
- Register both locale properties in GSC (`/ar/` prefix variant and root) or use a single domain property.

---

## Ecommerce-specific GSC actions

### Structured data monitoring (highest priority)

GSC Enhancements reports catch `Product` schema errors before they silently cost rich results.

1. **GSC → Enhancements → Shopping** — check for missing `price`, `priceCurrency`, `availability`, or `image` on product pages. The `structured-data.ts` `productJsonLd()` already emits all required fields; errors here usually mean a product has no image or the price is zero.
2. **Rich Results Test** (`https://search.google.com/test/rich-results`) — spot-check a PDP URL (e.g. `https://wadyaljuz.com/products/<slug>`) to confirm `Product` JSON-LD renders correctly.
3. **`X-Robots-Tag` confirmation** — no product page should emit `noindex`. The current setup doesn't, but confirm after any middleware change.

### Google Merchant Center (separate from GSC)

For Google Shopping product listings (paid + free), connect `wadyaljuz.com` to **Google Merchant Center** (not GSC). The existing `Product` JSON-LD feeds into free product listings automatically once the domain is verified in Merchant Center. This is separate from, but complementary to, GSC.

### Coverage report — check after sitemap submission

After submitting the sitemap, GSC → Indexing → Pages will show:

- **Indexed** count should grow over ~1-2 weeks
- **Excluded: Duplicate without canonical** — check if `store.forcemediakw.com/wady-aljuz/...` URLs appear here (means old platform paths are competing with the custom domain)
- **Crawled, not indexed** — check for thin-content product pages

---

## What NOT to do

- Do not submit `llms.txt` to GSC. Google confirmed it doesn't use it for search.
- Do not submit `robots.txt` as a sitemap — it's not a sitemap.
- Do not add `<link rel="sitemap">` for `llms.txt` — not a crawlable document format for Google.
- Do not add hreflang tags when there are no separate locale URL paths — it is invalid and causes GSC errors.
- Do not set geographic target to "Saudi Arabia" or "All regions" for the wadyaljuz.com property — Kuwait targeting is the correct choice.

---

## References

- [Google Search Central: Build and Submit a Sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google Search Central: Structured Data for Ecommerce](https://developers.google.com/search/docs/specialty/ecommerce/include-structured-data-relevant-to-ecommerce)
- [Google's llms.txt guidance (SearchEngineJournal, 2025)](https://www.searchenginejournal.com/googles-llms-txt-guidance-depends-on-which-product-you-ask/575431/)
- [Anthropic Claude bots framework — ClaudeBot vs Claude-SearchBot](https://almcorp.com/blog/anthropic-claude-bots-robots-txt-strategy/)
