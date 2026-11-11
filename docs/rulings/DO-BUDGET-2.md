# DO-BUDGET-2 - a verified storefront render spends no public read bucket

**Ruling DO-BUDGET-2 - a request from ebda-web whose `x-ebda-ssr-auth` HMAC verified (cf/ssr-client-ip.ts, RL-SSR-IP-6) skips `publicLimiter`, `publicTenantLimiter` and `storeResolveLimiter`; it keeps the store-miss limiter (peek + count of 404s per shopper address).** Evidence 2026-11-11 (business/ebda/audits/2026-11-11-do-request-spike.md): AuthState = 39% of ~205k DO requests/day, 2.3 per api request, most from SSR fan-out. Measured on workerd (workers-test/public-do-calls.test.ts): resolve from the internet = 3 limiter calls, verified render = 1 (the miss peek), 0 hits.

Unforgeable: trust is membership of `trustedSsrRequests` (WeakSet), filled by app.ts from a header only worker.ts sets after a constant-time WebCrypto `verify` of HMAC-SHA256(REVALIDATE_SECRET, address) on a GET/HEAD of an anonymous storefront read. Every inbound copy of the marker and both forward headers is deleted first; Host, X-Forwarded-For and a typed marker are never consulted. No secret on the API = nothing trusted. Secret is held by ebda-web and ebda-api only.

Resolve cache in web (RESOLVE-BULLETPROOF-1, #519, 60 s hit / 30 s miss, epoch-checked) already exists; staleness note lives at apps/web/src/lib/store-resolve-cache.ts. Misses are cached 30 s as definitive misses only (never as a positive); unresolved host still 404s.

`/cutover/stores/*/__export` is NOT a leftover poller: it is the NZ-BACKUP-1 nightly backup (GitHub cf-backup.yml 02:17 UTC, Mac launchd com.ebda.os.ebda-cf-backup 07:15 local via backup-ebda-cloudflare.sh, app.ebda.cf-backup-pull 08:05, weekly restore-drill Sun 05:00). ~1.9k/day = a few paged runs x 7 stores. Kept; to cut it, drop the Mac 07:15 duplicate of the GitHub run (Ahmad's call, outside this repo).

Residual: a shopper is bounded by Cloudflare's edge, the miss limiter and caches, not the 300/min bucket, for SSR reads. Cost if wrong: an abusive client hammering SSR pages is not throttled at the API (web caches absorb most) - revert by removing the `isTrustedSsr` checks.
