# GSC for custom merchant domains (e.g. ameliaaurum.com) — 2026-11-15

## Finding (code-read, not measured live)

- Custom domains are Cloudflare-for-SaaS custom hostnames (`services/cloudflare-domain.service.ts`) on the MERCHANT's DNS (CNAME to our fallback origin). `Store.domain` holds only the VERIFIED domain (`domainStatus='active'`); a claim lives in `pendingDomain`.
- The storefront already renders `Store.googleSiteVerification` as `<meta name="google-site-verification">` on the custom host (`apps/web/src/lib/storefront-metadata.ts`, per-store token only on a custom domain).
- The platform service account (`ebda-gsc@ebda-search`) only sees `sc-domain:ebda.app`, so a custom domain has no GSC property and gets no data.

## Automatic path: exists (META method)

We control the HTML of the verified domain, so the merchant does nothing:

1. `POST siteVerification/v1/token` `{site:{type:SITE,identifier:https://<host>/}, verificationMethod:META}` returns a `<meta ... content="X">` snippet. The token is deterministic per (site, account, method), so the call is idempotent.
2. Write X to `Store.googleSiteVerification` via `StoreService.updateSeo` (busts the storefront cache). Never overwrite a different existing token (the merchant verified in their own Search Console): status `merchant_token`, skipped.
3. `POST siteVerification/v1/webResource?verificationMethod=META` makes the service account a verified owner.
4. `PUT webmasters/v3/sites/https%3A%2F%2F<host>%2F` (`sites.add`) registers the property.

DNS_TXT is NOT used (needs the merchant's DNS). FILE is not needed.

## Build (this PR)

- `gsc-domain-verification.service.ts`: `ensureGscDomainProperty(storeId, deps)`, deps injectable; returns a status, never throws for a Google failure. Write token is minted separately (`mintGscWriteToken`, scopes `siteverification` + `webmasters`); the ingest keeps its read-only token.
- Wired into `ingestStoreGsc` (daily 04:00 UTC cron, per-store step, already fail-soft). No new job. A store whose exact property is already accessible costs zero Google writes. A failed verify retries the next day.
- Merchant status: the answer-engine GSC empty state shows `setup: 'verifying'` (custom domain not yet visible to the account) or `'awaiting_data'` (ar + en copy). Derived live from `sites.list` (cached), no new column.
- Tests use mocked fetch/deps only. No Google write has been made from development.

## Ahmad must do (cannot be done from code)

1. Enable the **Google Site Verification API** (`siteverification.googleapis.com`) in Google Cloud project `ebda-search`. (Search Console API is already on.)
2. Nothing else for scopes: a service account requests `siteverification` and `webmasters` in its own JWT; no domain-wide delegation. If Google answers 403 `accessNotConfigured` in the logs (`gsc-verify: getToken rejected status 403`), step 1 is the cause.

## Not verified

First live verification of a real merchant domain (needs step 1, then one cron tick). Whether Google accepts the service account as owner on a Cloudflare-fronted site with a ~1 min storefront cache lag: the first attempt right after publishing the token may be `verify_failed`; the next day's run retries.
