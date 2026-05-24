# Lighthouse storefront audit

Nightly Lighthouse CI run captures accessibility + performance + SEO + best-practices scores for the live Wady Aljuz storefront.

## Baseline (2026-05-24)

Median of 3 desktop runs per URL. Config: `apps/web/lighthouserc.json`. Throttling: 40ms RTT / 10Mbps.

| URL                                  | Performance | Accessibility | Best-Practices | SEO  |
| ------------------------------------ | ----------- | ------------- | -------------- | ---- |
| /                                    | 84          | 96            | 74             | 100  |
| /products                            | 70          | 92            | 74             | 100  |
| /products/fine-turkish-yellow-bulgur | 88          | 96            | 74             | 92   |
| /cart                                | 73          | 95            | 74             | 66\* |
| /checkout                            | 84          | 100           | 74             | 66\* |

\*Cart and checkout have intentional `<meta name="robots" content="noindex, nofollow" />` — the 66 SEO score is expected. These pages should NOT be indexed.

### Core Web Vitals (desktop, median)

| URL              | FCP    | LCP    | TBT | CLS   | Speed Index |
| ---------------- | ------ | ------ | --- | ----- | ----------- |
| /                | 1712ms | 1578ms | 0ms | 0.004 | 2451ms      |
| /products        | 1787ms | 3320ms | 0ms | 0.005 | 2277ms      |
| /products/<slug> | 1532ms | 1532ms | 0ms | 0.004 | 1674ms      |
| /cart            | 1802ms | 2801ms | 0ms | 0.005 | 2308ms      |
| /checkout        | 1647ms | 1647ms | 0ms | 0.020 | 2073ms      |

## Top accessibility issues (first pass)

1. **Insufficient contrast ratio** — 12 occurrences across all 5 URLs (affects all pages). Most likely product card text or secondary UI on the storefront theme.
2. **Heading levels out of sequence** — 6 occurrences across 2 URLs. `h3` or `h4` likely skipping an `h2`.
3. **Select elements missing associated labels** — 3 occurrences (likely quantity picker or sort dropdown). Needs `<label>` pairing.

## Top best-practices issues (first pass)

1. **Browser console errors** — 401 and 404 errors logged on every page load. 401 likely from a preflight auth check; 404 from a missing asset or API endpoint. Both drive the 74 BP score. Investigate with DevTools Network tab on `/`.
2. **Third-party cookies** — OneSignal SDK (`cdn.onesignal.com`) sets `__cf_bm` (Cloudflare bot management cookie). This is a third-party cookie flagged by Chrome's deprecation initiative. Lighthouse penalises it. Not fixable without removing OneSignal or using a self-hosted proxy.
3. **Chrome DevTools Issues panel warnings** — typically linked to the above two (third-party cookies + console errors).

## Top performance issues (first pass)

1. **LCP on /products is 3320ms** — likely the product grid loading above-the-fold images lazily. Priority: add `priority` prop to the first visible product image.
2. **Render-blocking requests** — 14 occurrences. Likely fonts or third-party scripts (OneSignal, Sentry).
3. **Legacy JavaScript** — all 15 runs flagged. Next.js is shipping some legacy transforms. Check `next.config.js` browserslist target.
4. **No efficient cache policy on static assets** — CDN cache headers may be missing `Cache-Control: max-age=31536000` on hashed assets.
5. **bfcache blocked on all pages** — common with `Cache-Control: no-store` or certain event listeners. Low effort win if fixed.

## Where reports live

- LHCI JSON + HTML results: `.lighthouseci/` in the repo root (local only, gitignored)
- CI run results upload to **temporary public storage** (~30 days retention per upload)
- (Future) wire `LHCI_SERVER_URL` to a persistent LHCI server for trend graphs

## When to act on a regression

| Condition                                | Priority                                      |
| ---------------------------------------- | --------------------------------------------- |
| Accessibility drops below 85             | HIGH — file an issue immediately              |
| Performance drops below 60               | HIGH — Core Web Vitals regression             |
| Performance drops below 70               | MEDIUM — investigate next working day         |
| SEO drops below 90 on `/` or `/products` | HIGH — likely a meta tag or robots regression |
| Best-practices drops below 65            | LOW — check for new console errors            |

## Running locally

```bash
# From repo root
npx lhci collect --config=apps/web/lighthouserc.json
npx lhci assert --config=apps/web/lighthouserc.json
```

Results land in `.lighthouseci/`. Open the `.html` files for full reports.

## CI workflow

`.github/workflows/lighthouse-nightly.yml` runs at 4am UTC (7am Kuwait) daily, plus manual trigger via `workflow_dispatch`. Results upload to temporary public storage. The `LHCI_GITHUB_APP_TOKEN` secret is optional — if unset, reports still upload anonymously.
