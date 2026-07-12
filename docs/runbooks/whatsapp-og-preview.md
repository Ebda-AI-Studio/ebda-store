# WhatsApp / Social Link Preview Runbook

## How it works

Every storefront page emits per-store Open Graph meta tags so that pasting a
store URL in WhatsApp, iMessage, Telegram, Slack, Twitter/X, or Facebook shows
a branded link preview instead of a blank card.

The implementation has two layers:

### 1. `generateMetadata()` in `apps/web/src/app/layout.tsx`

Emits the following for every page (including inner pages like `/products/slug`
and `/categories`):

```html
<meta property="og:title" content="Store Name - Online Shopping in Kuwait" />
<meta property="og:description" content="Shop online at Store Name. ..." />
<meta property="og:url" content="https://storename.com" />
<meta property="og:site_name" content="Store Name" />
<meta property="og:image" content="https://pub-xxx.r2.dev/stores/1/logo.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Store Name" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="..." />
```

**Image priority order:**

1. `store.ogImage` — admin-configured OG image (preferred; set in Admin → SEO)
2. `store.logo` — store logo uploaded in Admin → Branding
3. `/opengraph-image` — generated branded 1200×630 card (fallback, always available)

Only absolute `https://` URLs are accepted for (1) and (2). Any non-https URL
is silently rejected and the fallback `/opengraph-image` route is used instead.

The utility function lives at `apps/web/src/lib/seo/og-image.ts`.

### 2. `opengraph-image.tsx` — Generated OG card

`apps/web/src/app/opengraph-image.tsx` is a Next.js App Router special file
that generates a 1200×630 PNG via `next/og` (Satori). It runs on the **edge
runtime** for low latency.

The card renders:

- **Background**: linear gradient using the store's `theme.primaryColor` HSL value
  (falls back to Force AI brand orange `hsl(26, 100%, 50%)`)
- **Center**: store logo on a white pill background (transparent PNG safe), or the
  store name in large white text when no logo is uploaded
- **Bottom badge**: store name in a semi-transparent pill

The store is resolved via `getStore()` which reads the request headers set by the
multi-tenant middleware — the same mechanism used by all storefront pages. Each
store gets its own branded card at no extra configuration.

---

## Testing WhatsApp previews

WhatsApp caches OG images aggressively. A fresh URL will scrape on the first paste,
but subsequent pastes of the same URL show the cached version for hours.

### Quick validation

1. **Facebook Sharing Debugger** — <https://developers.facebook.com/tools/debug/>
   Paste the store URL and click "Debug". It re-scrapes and shows exactly what
   WhatsApp will display. Click "Scrape Again" to bust the platform cache.
   This is the fastest way to verify a logo or OG image change went live.

2. **Twitter Card Validator** — <https://cards-dev.twitter.com/validator>
   Validates `twitter:card` + `twitter:image`.

3. **OpenGraph.xyz** — <https://www.opengraph.xyz/>
   Live preview across WhatsApp, Telegram, Slack, iMessage, Twitter.

4. **Direct URL check** — Visit `https://your-store.com/opengraph-image` in a
   browser. The browser renders the generated PNG directly so you can see the
   card without a scraper tool.

### After a logo/OG image change in Admin

1. Deploy the change (`cf-deploy.yml` auto-deploys the storefront Worker on push to `main`).
2. Paste `https://your-store.com/opengraph-image` in a browser tab — verify the
   new logo appears.
3. Use the Facebook Sharing Debugger to scrape the store's homepage URL. This
   pushes the new `og:image` URL to WhatsApp's CDN cache.
4. Wait 30–60 seconds and paste the URL in a fresh WhatsApp conversation.

### Cache busting for the generated card

The `/opengraph-image` route is cached by Next.js and Cloudflare's edge cache. If you need
to force-refresh the generated card after a brand color or logo change, purge the URL from
the Cloudflare dashboard (Caching → Configuration → Custom Purge) or via the Facebook Sharing
Debugger "Scrape Again" button — WhatsApp reads from Facebook's scrape cache and this forces a
re-fetch from the origin.

---

## Troubleshooting

| Symptom                                       | Likely cause                       | Fix                                                                                                    |
| --------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Blank preview on WhatsApp                     | `og:image` missing or relative URL | Check `store.logo` is uploaded and is an absolute `https://` URL; or visit `/opengraph-image` directly |
| Old logo still showing                        | WhatsApp CDN cache                 | Use Facebook Sharing Debugger "Scrape Again" on the store URL                                          |
| Generic "Force" branded card, not store brand | `store.logo` is empty              | Upload a logo in Admin → Branding; the generated card will pick it up                                  |
| `og:image` dimensions missing                 | Pre-PR version of layout.tsx       | Redeploy; the fix adds explicit `width: 1200` + `height: 630`                                          |
| Card shows but is cut off                     | Non-standard logo aspect ratio     | The `/opengraph-image` card uses `objectFit: contain` in a `420×220` box — all aspect ratios are safe  |
