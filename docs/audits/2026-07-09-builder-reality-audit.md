# FWB Builder Reality Audit v1 (2026-07-09)

**Scope:** Four founder-education-reel-derived lenses — (A) cache correctness/staleness, (B) token/auth hardening, (C) client-side UX/frustration observability, (D) business & legal protection — audited read-only against `apps/api`, `apps/web`, `apps/admin`, `apps/orders`. This is a delta audit: it assumes the 2026-07-02 MASTER deep audit's 10 lenses (tenancy/RLS, money, scaling, reliability, security surface, observability/DR/CI-CD, deps, product completeness, feature-flags, i18n) as read and does not re-litigate findings already logged there except to extend or reclassify them.

> **Remediation status (2026-07-09):** all 10 code findings (3 High / 5 Med / 2 Low) fixed on branch `fix/builder-reality-audit`. Lens A: order-driven inventory paths now bust product caches; `invalidateCachedPrefix` clears Redis (SCAN+UNLINK) not just in-memory; `getCached` single-flights concurrent misses. Lens B: `wa-bridge` JWT sign+verify now algorithm/issuer/audience-pinned. Lens C: Orders PWA got PostHog (Sentry was already present — the audit mis-read that); Sentry↔PostHog linked by distinct_id on all 3 apps; session-replay intentionally kept OFF (Ahmad's call). Lens D3: privacy policy now names PostHog/Sentry/OneSignal/Resend + retention + international-transfer; Terms got Governing-Law (Kuwait) + as-is disclaimer. D1/D2 (non-code): `docs/business/cyber-liability-insurance-brief.md` + `docs/business/vendor-liability-exposure.md` written. Verify: 1130/1130 unit tests green, 0 new typecheck/lint issues.

**Headline:** FWB's auth token hardening is genuinely strong (algorithm-pinned HS256 verification with issuer/audience checks, ≥32-char secret enforcement, rotating refresh tokens with reuse-detection, httpOnly/SameSite=None cookies) — one inconsistent verify call on a low-blast-radius WhatsApp-bridge endpoint is the only gap. Cache correctness is more mixed: feature-flag/plan entitlement caching is a model implementation (event-invalidated, no TTL reliance), but the product cache (which carries **price and inventory** — the two data classes this audit's framing calls out as never-stale) has two real gaps — a known Redis-not-cleared issue (previously logged as LOW/scaling) that this audit reclassifies as a **money/trust-risk** given it holds price, and a **new, unlogged** gap where checkout-driven inventory decrement never invalidates the product cache at all. Client-side UX observability is the weakest lens: PostHog is installed and consent-gated correctly, but session replay is explicitly disabled everywhere and the Orders PWA (the fulfilment staff's only UI) has neither analytics nor error monitoring — so a courier-facing crash today is as invisible as it was on 2026-07-02. Lens D surfaces two legitimate net-new gaps that are entirely non-code: no cyber-liability insurance and no documented vendor-liability-cap exposure table, both flagged as business action items, not code defects.

---

## Lens A — Cache correctness & staleness

### A1. Cache inventory by staleness class

| Key(s)                                        | Store                                                   | TTL                                       | Class                                                                                   | Evidence                                                                  |
| --------------------------------------------- | ------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `public:store:<storeId\|slug>`                | Redis + in-mem fallback (`getCached`)                   | 120s                                      | bounded (store metadata: name, theme, layout)                                           | `apps/api/src/routes/public.routes.ts:1075`, `store-layout.routes.ts:809` |
| `public:categories:<storeId>`                 | Redis + in-mem                                          | 120s                                      | bounded                                                                                 | `public.routes.ts:275`                                                    |
| `public:products:<storeId>:<query...>`        | Redis + in-mem                                          | 120s (list), edge `s-maxage=60`           | **NEVER-stale (carries `price`, `inventory`/`inStock`)** — currently treated as bounded | `public.routes.ts:196-223`                                                |
| `public:product:<storeId>:<slugOrId>`         | Redis + in-mem (anonymous only; authenticated bypasses) | 120s, edge `s-maxage=60`                  | **NEVER-stale (price/stock)**                                                           | `public.routes.ts:247-261`                                                |
| `public:suggest:<storeId>:<q>`                | Redis + in-mem                                          | 120s                                      | bounded (search suggestions)                                                            | `public.routes.ts:846-849`                                                |
| `features:store:<storeId>`                    | Redis only                                              | 300s                                      | **NEVER-stale (plan/feature entitlement)**                                              | `apps/api/src/services/feature.service.ts:6-7`                            |
| `csrf:<sessionId>`                            | Redis                                                   | 3600s                                     | session-scoped, not a staleness concern                                                 | `redis.service.ts:90-93`                                                  |
| `session:<sessionId>`                         | Redis                                                   | 86400s                                    | session-scoped                                                                          | `redis.service.ts:109-116`                                                |
| `jti:deny:<jti>` / `user:tv:<userId>`         | Redis                                                   | token-lifetime / indefinite               | **NEVER-stale (permissions/session revocation)**                                        | `redis.service.ts:230-253`                                                |
| `customers:<storeId>` aggregation             | Redis + in-mem                                          | 300s                                      | bounded (admin-only analytics)                                                          | `customers.routes.ts:338-350`                                             |
| `store:slug:<slug>` / `store:domain:<domain>` | Redis (direct, not via `getCached`)                     | none set (persists until explicit delete) | bounded, invalidated on every store/domain write                                        | `store.service.ts:68-69, 285-290, 443-444`                                |

Store metadata, categories, and search suggestions are correctly bounded. **Product price and inventory are the two data classes this audit's framing marks never-stale, and FWB currently treats them as a 120s-bounded cache** — see A2 for the two concrete gaps this produces. Feature/plan entitlement is correctly modeled as never-stale (see below).

### A2. Event-invalidation vs TTL-only

**✅ Status: PASS · Verdict: CONFIRMED · Feature-flag / plan entitlement caching**
Every write path that changes what a store is entitled to — `setStorePlan`, `updateStoreFeatures`, `clearFeatureOverride`, `resetAllOverrides` — calls `redis.delete`/re-populates the cache **inside the same call**, before returning. There is exactly one caller of `setStorePlan` (`feature.routes.ts:312`) and no code path writes `Store.plan` directly, so there's no bypass. This is genuinely event-driven invalidation, not TTL-reliant — the 300s TTL is a pure safety net.
Evidence: `apps/api/src/services/feature.service.ts:122-129, 181-232, 251-262, 268-273, 281-296`.

**✅ Status: PASS · Verdict: CONFIRMED · Permissions / store-access (role checks)**
`requireStoreAccess` and `checkStoreAccess` do a **live, uncached** DB read (`prisma.store.findUnique` + `storeStaff.findUnique`) on every single request — there is no caching layer here at all, so removing a staff member's `StoreStaff` row takes effect on their very next API call, not bounded by any TTL.
Evidence: `apps/api/src/middleware/store-access.ts:40-134`.
Minor/Low note: the coarse `role` claim baked into the access-token JWT itself (e.g. `store_admin`→downgraded) only refreshes on the next `/auth/refresh` (≤30 min access-token lifetime) — this is a documented, intentional design tradeoff (CLAUDE.md), not a caching bug, and is short enough not to be a real risk.

**⚠️ Status: PARTIAL · Verdict: CONFIRMED (extends/reclassifies a 2026-07-02 finding) · Product cache Redis layer never explicitly invalidated — carries price**
`invalidateCachedPrefix()` — the function every product write path calls (`create`, `update`, `delete`, `bulkUpdate` all funnel through `ProductService.invalidateStoreProductCache`, plus the two carousel-reorder routes) — **only clears the in-memory `BoundedMap` fallback**. The Redis-backed `cache:public:products:*`, `cache:public:product:*`, and `cache:public:suggest:*` keys are never deleted by any code path in the repo (`grep` for `redis.delete` confirms zero hits against those prefixes) — the code's own comment documents this as accepted: _"Redis pattern delete would require SCAN; instead we let Redis entries naturally expire on their TTL."_

- Evidence: `apps/api/src/lib/public-cache.ts:58-85` (only `invalidateCached`, called for `categories`/`store`, actually issues `redis.delete`); `apps/api/src/services/product.service.ts:504-533` (`invalidateStoreProductCache` — Redis delete only for `categories:store:*`/`public:categories:*`, `invalidateCachedPrefix` — in-memory-only — for `public:products:*`/`public:suggest:*`/`public:product:*`).
- 2026-07-02 delta: `2026-07-02-scaling-perf.md` finding #4 already flagged this exact code as LOW/**PLAUSIBLE**, framed as a horizontal-scaling perf concern ("unverified at multi-replica scale"). This audit **read the code directly and confirms it as CONFIRMED**, and reclassifies it through the money lens: on Railway's multi-replica deployment, a merchant's price correction (or a bulk `-30%` sale-price edit) is invisible to every OTHER API pod — and to the SAME pod after a restart — for up to 120s via the still-live Redis entry, not just the in-memory copy the original finding focused on. Net effect for the merchant: a price they just fixed can still be served, correctly-signed, to a live customer for up to 2 minutes.
- **Severity: High** (reclassified up from the original LOW, because price — not just perf-hygiene — is the exposed data).
- **Fix:** switch to Redis `SCAN`+`UNLINK` on the `cache:public:products:<storeId>:*` pattern (bounded cardinality per store), or maintain a per-store Redis `SET` of active cache-key suffixes to `SREM`+`DEL` in O(1) without SCAN.

**❌ Status: GAP · Verdict: CONFIRMED (net-new — not present in the 2026-07-02 audit set) · Checkout-driven inventory change never invalidates the product cache at all**
`order.service.ts` decrements inventory atomically inside the order-create transaction (`decrement`, the oversell-safe `UPDATE … WHERE inventory >= qty` path) and restores it on cancel/refund/payment-failure (three separate restore sites) — but **none of these paths call `invalidateCached`/`invalidateCachedPrefix`**, not even the in-memory layer. This is a different failure mode from the finding above: that one is "the invalidation call exists but only clears one of two layers"; this one is "the highest-frequency, most inventory-sensitive write path in the whole system never calls invalidation at all."

- Evidence (decrement — order create): `apps/api/src/services/order.service.ts:365-450` (no invalidation call in the surrounding transaction or after it).
- Evidence (restore — payment-create rollback): `order.service.ts:765-790`.
- Evidence (restore — cancel/refund): `order.service.ts:1206-1295`.
- Confirmed via `grep -n "invalidateCached" apps/api/src/services/order.service.ts` → zero matches.
- **Business impact:** a product that sells out on the last unit at checkout keeps showing "in stock" on the PLP/PDP for other visitors for up to 120s (product cache) / 60s (edge cache). Because the order-create path's own oversell guard is transactionally atomic (confirmed by the 2026-07-02 money-integrity audit), this does **not** cause a double-sell or financial loss — a second buyer's checkout attempt correctly fails with "not enough inventory." The cost is pure trust/frustration: a customer adds a now-gone item to cart, only to be told it's unavailable at checkout instead of on the listing — most damaging during flash sales / low-stock high-demand SKUs, which is exactly when merchants care most about it looking accurate.
- **Severity: High** (frustration/trust class, bounded blast radius, no money leak — capped below Critical because the checkout-time guard prevents any actual oversell).
- **Fix:** call `invalidateCachedPrefix('public:products:<storeId>:')` + `invalidateCached('public:product:<storeId>:<slug>')` (mirroring `ProductService.invalidateStoreProductCache`) from the three inventory-mutation sites in `order.service.ts` — ideally by exporting and reusing `ProductService`'s existing invalidator rather than duplicating cache-key logic.

### A3. Cache-miss stampede protection

**❌ Status: GAP · Verdict: CONFIRMED · No single-flight / lock on any hot cached read**
`getCached()` — the shared wrapper behind product list/detail, categories, store lookup, and customer aggregation — has no de-duplication of concurrent misses: on a TTL expiry, every simultaneous request that misses both Redis and the in-memory fallback independently calls `fetchFn()` and independently re-populates the caches. There is no `acquireLock`/mutex use inside `getCached` itself, even though `redis.service.ts` already exposes a working `acquireLock`/`releaseLock` primitive (used elsewhere, e.g. distributed job locks) that could be reused here.

- Evidence: `apps/api/src/lib/public-cache.ts:26-56` — the miss path (`redis.get` miss → `memoryCache.get` miss → `fetchFn()`) has no lock acquisition anywhere in between.
- `featureService.getStoreFeatures` has the identical shape/gap (`feature.service.ts:139-154`), lower risk given fewer concurrent callers per store and a 300s TTL.
- **Business impact:** on the highest-traffic store's product-list endpoint, every 120s TTL boundary is a mini thundering-herd against Neon — N concurrent storefront visitors on a popular category page each trigger a full `ProductService.listPublic` DB call simultaneously instead of one query + N cache hits. `2026-07-02-scaling-perf.md` already frames the general "cold-cache-stampede" scenario as a documented tradeoff at current traffic; this finding gives it a precise, confirmed root cause (`getCached` has zero locking) rather than leaving it as an assumption.
- **Severity: Medium** (bounded by current traffic; becomes High as any single store's concurrency grows — flash sales are again the worst case, compounding with the A2 finding above).
- **Fix:** wrap the miss path in `redis.acquireLock('cache-fill:' + key, 5)` with a short retry-then-serve-stale fallback, or move to a stale-while-revalidate pattern (serve the expired value while one request refreshes in the background) — cheaper to implement than a hard lock and matches the `edge-cache.ts` SWR language already used one layer up.

---

## Lens B — Token / auth hardening

**✅ Status: PASS · Verdict: CONFIRMED · B1 — `alg: none` explicitly rejected**
Every core `jwt.verify` call in the primary auth path passes an explicit `algorithms: ['HS256']` option, which causes the `jsonwebtoken` library to reject a token asserting `alg: none` (or any other algorithm) outright, regardless of what the token header claims.
Evidence: `apps/api/src/middleware/auth.ts:63-67` (`authenticate`) and `:135-139` (`optionalAuthenticate`).

**✅ Status: PASS · Verdict: CONFIRMED · B2 — algorithm pinned on verify (5 of 6 call sites)**
Algorithm is explicitly pinned to `['HS256']`, paired with `issuer:'force-api'` + `audience:'force-app'` (or a distinct audience for special-purpose tokens), on:

- `apps/api/src/middleware/auth.ts:63-67, 135-139` (access token)
- `apps/api/src/routes/mfa.routes.ts:149` (MFA challenge token, distinct `audience`)
- `apps/api/src/routes/auth.routes.ts:362` (refresh-token-as-body verify)
- `apps/api/src/services/socket.service.ts:133` (Socket.io handshake auth)

This closes the algorithm-confusion class of attack (an HS256-signed token can't be replayed against an RS-expecting verifier or vice versa) and is symmetric-secret-only throughout — no RS/ES keys in play, so there's no public-key-as-HMAC-secret vector either.

**❌ Status: GAP · Verdict: CONFIRMED · B2 — one inconsistent verify call**
`apps/api/src/routes/wa-bridge.routes.ts:891` — `jwt.verify(token, config.jwtSecret) as Record<string, unknown>` — passes **no `algorithms` option and no `issuer`/`audience`**, unlike every other verify call in the codebase. The paired `jwt.sign` at `wa-bridge.routes.ts:823` (minting the single-use WhatsApp-checkout cart token) is equally bare: only `expiresIn`, no explicit `algorithm`/`issuer`/`audience`.

- **Exploitability today is low**, not because the code is safe by construction but because of two accidental mitigations: (1) `jsonwebtoken`'s default behavior when a symmetric string secret is passed and no `algorithms` array is given still restricts to HMAC family (rejects RS/ES-typed tokens, and never accepts `none`), and (2) the handler checks `payload.sub !== 'wa-cart'` after verify, which incidentally filters out any other same-secret-signed token (access, refresh, MFA-challenge, impersonation) that doesn't happen to carry that exact `sub`.
- The real gap is **inconsistency, not an active bypass**: this is the one JWT verify in the codebase with no algorithm pin and no audience/issuer scoping, so it doesn't benefit from the same defense-in-depth the rest of the auth surface has, and a future refactor that changes the `sub` check (or adds another token type sharing `config.jwtSecret`) could silently reopen a real cross-token-replay path.
- **Severity: Medium.**
- **Fix:** add `{ algorithms: ['HS256'], issuer: 'force-api', audience: 'force-wa-cart' }` to both the `jwt.sign` and `jwt.verify` calls in `wa-bridge.routes.ts`, matching the pattern already used for the MFA-challenge token (`mfa.routes.ts:149`) which has its own dedicated audience.

**✅ Status: PASS · Verdict: CONFIRMED · B3 — short-lived tokens, rotation, secure storage, secret strength**

- **Expiration:** access token `JWT_EXPIRES_IN` defaults to 30 minutes; refresh token `REFRESH_TOKEN_EXPIRES_IN` defaults to 365 days but is DB-backed and rotates on every use. No non-expiring token issuance found anywhere (`grep` for `jwt.sign` calls shows every one carries `expiresIn`).
  Evidence: `apps/api/src/services/auth.service.ts:1068-1120`.
- **Rotation + revocation:** every refresh call rotates the token (old row `revokedReason='rotated'`, `replacedById` back-link); replay of an already-rotated token revokes the whole family. Logout / password-change bumps a per-user `tokenVersion` (`user:tv:<userId>` in Redis) checked on every request (`auth.ts:93-109`), giving immediate bulk revocation without waiting for JWT expiry. Per-token JTI denylist (`jti:deny:<jti>`) covers single-session logout.
  Evidence: `auth.ts:85-109`, `redis.service.ts:230-253`, CLAUDE.md "Rotating refresh tokens" section (consistent with code).
- **Storage:** both cookies (`token`, `refresh_token`) are `httpOnly: true`, `secure: true` in production, `sameSite: 'none'` in production (required for the cross-origin API↔frontend split) — not `localStorage`, so not directly exposed to XSS-driven token theft.
  Evidence: `apps/api/src/routes/auth.routes.ts:23-25, 39-41`.
- **Secret strength:** `JWT_SECRET` is required (hard-fails boot) in production, must be ≥32 chars, and is checked against a placeholder-string denylist (`change-in-production`, `your-super-secret`, `changeme`, `placeholder`) — a copy-pasted example secret from a `.env.example` would fail boot, not silently run.
  Evidence: `apps/api/src/config/index.ts:6-16, 277-287`.

**Net for Lens B:** production-grade. The one gap (`wa-bridge.routes.ts:891`) is a low-blast-radius, single-use, feature-scoped endpoint (WhatsApp bot checkout handoff) — worth a quick fix for consistency, not an emergency.

---

## Lens C — UX / frustration observability (client-side)

**⚠️ Status: PARTIAL (installed + consent-gated, but replay deliberately OFF) · Verdict: CONFIRMED · C1 — session replay**
PostHog is installed on **web** (consent-gated) and **admin** (always-on, justified as internal-operator telemetry) via `posthog-js`, both pointed at `https://eu.i.posthog.com` by default (EU data residency). But **`disable_session_recording: true` is set explicitly in both providers** — session replay is not merely unconfigured, it is deliberately turned off by a documented design decision ("we only want behavioural analytics, not session replay (which has bigger consent implications)").

- Evidence: `apps/web/src/components/PostHogProvider.tsx:46-66` and `apps/admin/src/components/PostHogProvider.tsx:45-52` (identical `disable_session_recording: true` in both).
- Consent gating (web only, correctly scoped): PostHog only initializes when `consent?.marketing === true` — a single "marketing" cookie category (per `ConsentContext.tsx`) covers all pixel/analytics types including PostHog, gated behind the cookie banner. — `PostHogProvider.tsx:33-39, 33-44`.
- Admin is ungated by design (no public visitors, operator telemetry) — reasonable, though worth noting PostHog still captures admin staff clicks/pageviews; not a compliance issue since it's internal tooling usage, not customer data.
- **`apps/orders` (the fulfilment PWA) has zero PostHog references anywhere** — confirmed via repo-wide grep. This compounds the already-logged 2026-07-02 finding "Orders PWA ships with zero Sentry" — the surface store staff use to run live fulfillment has **no analytics AND no error monitoring**, so neither a crash nor a confusing UX moment during order processing leaves any trace anywhere.
- **Severity: Medium** (product/growth-visibility gap, not a security or money issue — but the Orders-PWA blind spot specifically is High, since it's operational, not just marketing).

**❌ Status: GAP (nothing to link — replay doesn't exist) · Verdict: CONFIRMED · C2 — replay linked to error tracking**
Since session replay is off everywhere, there is nothing for Sentry exceptions to link to. No `posthog.identify()` call exists anywhere in the codebase (confirmed via grep), and no Sentry↔PostHog integration wiring (session-ID tagging, `Sentry.setContext('posthog', ...)`, or PostHog's own error-tracking beta) is present. An error in Sentry today has zero causally-linked UX context beyond whatever breadcrumbs Sentry itself captures.

- **Severity: Medium** — this is a downstream consequence of C1, not a separate implementation gap; fixing C1 (turning replay on, even sampled) is the prerequisite for C2 to be actionable at all.

**⚠️ Status: PARTIAL · Verdict: PLAUSIBLE · C3 — rage-click / dead-click detection**
PostHog's client-side `autocapture` is not explicitly disabled in either provider's `init()` call, so it runs at its default (on) — meaning click events are captured, and PostHog's backend computes `$rageclick` events from autocaptured click patterns automatically, without requiring session recording. **Dead-click detection**, however, is a PostHog feature that depends on session-replay data being present — so with replay off, that half of "frustration-signal detection" doesn't exist regardless of autocapture state.

- Whether anyone actually looks at the PostHog dashboard for rage-click signals is not verifiable from the repository (it's a PostHog-cloud-side dashboard, not code) — flagged **PLAUSIBLE**, needs a runtime/product-process check ("does anyone open the PostHog Insights tab").
- **Severity: Low-Medium.**

---

## Lens D — Business & legal protection

**Business action item, not a code gap · D1 — Cyber-liability insurance**
No cyber-liability insurance policy is referenced anywhere in the repo (expected — this isn't a code artifact). Flagging as a standing to-do for Ahmad/ForceAI: typical GCC/US-facing SME cyber policies run **~$200-600/yr** for coverage in the $50k-$1M range, and FWB's security fundamentals (SQLi/CSRF/auth closed per 2026-07-02, JWT hardening confirmed above, `npm audit` 0/0/0/0) put the company in a reasonable position for underwriting — the gap is procurement, not preparedness. **Owner: Ahmad. Action: get quotes.**

**Business action item, partially addressable in docs · D2 — Vendor ToS liability caps**
No document in the repo (checked `docs/`, business docs, DR/vendor-lock-in references) enumerates the liability caps of FWB's critical-path vendors. This is genuinely net-new — the 2026-07-02 observability/DR audit covers _alerting and retention_ for these vendors but not their _contractual liability exposure_. Indicative exposure table (typical published ToS terms as of this audit; **not verified against FWB's actual signed/clicked agreements** — that verification is the actual action item):

| Vendor                      | What it holds                                                                             | Typical liability cap                                                                             | Blast radius if vendor loses/leaks data                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neon (Postgres)             | All tenant data: orders, customers, payments metadata, addresses                          | ~fees paid in preceding 12mo (standard cloud-DB ToS pattern)                                      | Platform-wide outage + potential full data loss if backups also fail — mitigated by the daily local `pg_dump` DR practice already in place                                                                       |
| Railway (API host)          | Nothing persistent (stateless API + Redis cache)                                          | ~last month's fees (standard PaaS ToS pattern)                                                    | Downtime only; no data-loss blast radius (Redis is cache, not source of truth)                                                                                                                                   |
| Cloudflare (Workers/R2/DNS) | Static assets, product images (R2), edge routing for all 3 frontends                      | Typically excluded/capped per their standard Enterprise/Business ToS                              | Storefront-wide outage + broken product images if R2 objects are lost; DNS misconfig risk is platform-wide                                                                                                       |
| Resend (email)              | Transactional email content in transit (order confirmations, password resets)             | ~fees paid, standard email-API ToS                                                                | Missed customer communications, not data loss (source of truth is FWB's own DB)                                                                                                                                  |
| PostHog                     | Behavioral analytics events (no PII beyond `distinct_id`, IP capture explicitly disabled) | ~fees paid, standard analytics-API ToS                                                            | Low — low-sensitivity data, EU hosting already chosen                                                                                                                                                            |
| MyFatoorah                  | Payment transaction data, cardholder-adjacent metadata                                    | Governed by MyFatoorah's own PCI-DSS + Kuwait CBK licensing terms, separate from generic SaaS ToS | High if breached, but this is a regulated PSP with its own compliance obligations — FWB's exposure is contractual (the platform integrates, doesn't hold card data itself per standard hosted-payment-page flow) |

**Action:** pull the actual current ToS/DPA for each vendor (especially Neon and Cloudflare, which hold the most sensitive data) and record the real cap figures in a `docs/business/vendor-liability-exposure.md` — the table above is a starting skeleton, not a substitute for reading the real agreements.

**⚠️ Status: PARTIAL · Verdict: CONFIRMED · D3 — privacy policy vs actual data collection**
The storefront's fallback privacy policy (`apps/web/src/app/privacy/PrivacyClient.tsx:14-214`, used when a merchant hasn't authored a custom `privacy` CMS page) is **not** a bare cookie-only template — it correctly discloses name/email/billing-shipping-address/payment-info collection (§1), usage purposes including "improve our products and services" (§2), a no-sale commitment + named categories of sharing (payment/shipping processors, law enforcement) (§3), a cookies section that covers "analyze site traffic and usage" and "personalize your shopping experience" (§5), and a rights section that **matches the actual implemented endpoints** — "Request deletion of your data" and "Export your data in a portable format" (§6) line up with the real `POST /auth/me/erase` and `GET /auth/me/export` routes (see D4).

- **Gap:** it never names PostHog, or any analytics/marketing vendor, specifically — "analyze site traffic and usage" is generic, not itemized by processor. It also doesn't reference the specific consent categories from the cookie banner (`ConsentContext` currently has a single `marketing` category covering all 7 pixel types — so the policy's genericness is at least internally consistent with the banner's genericness, but neither names PostHog by product name). It doesn't state a data-retention period, and doesn't mention international data transfer even though PostHog is EU-hosted (a point in FWB's favor that isn't being claimed in the policy).
- Since this is a **per-store customizable CMS page** with this text only as the un-customized fallback, the actual compliance responsibility is split between the platform (fallback quality) and each merchant (customization) — the fallback quality is adequate but not vendor-specific.
- **Severity: Low-Medium.**
- **Fix:** add a "Third-party services" bullet list naming PostHog (analytics), Sentry (error monitoring — no customer PII), OneSignal/web-push (notifications), Resend (email delivery), and the active payment gateway, with links to each vendor's own privacy policy — a 10-minute copy addition to the fallback template.

**✅ Status: PASS (existence confirmed; cascade correctness is the 2026-07-02 audit's territory, not re-litigated here) · Verdict: CONFIRMED · D4 — GDPR / Kuwait Law 13/2023 erasure + export**
Both endpoints exist and are wired to `authenticate`:

- `POST /auth/me/erase` — `apps/api/src/routes/auth.routes.ts:454-493`, backed by `AuthService.eraseAccount(userId)`, documented in-code as "irreversible PII anonymization (GDPR Art. 17 + Kuwait Law 13/2023 Art. 17)... nulls/scrubs every identifying field across the schema in a single transaction," distinct from the softer `DELETE /auth/me` (`:425-452`, a soft-delete that intentionally preserves PII/order history and only sets `deletedAt`).
- `GET /auth/me/export` — `auth.routes.ts:495` onward, returns a JSON bundle covering user, addresses, orders, abandoned carts, wishlists, reviews, returns, loyalty points/transactions, push subscriptions, and OneSignal subscriptions (`AuthService`, around `:1050-1066`).
  This matches CLAUDE.md rule 9 and is consistent with what the erase-endpoint's own comments claim; full cross-table cascade verification (does every tenant-scoped table actually get touched) is exactly the kind of thing the 2026-07-02 tenancy/PII lens is positioned to verify in depth — not repeated here.

---

## Tally

| Lens                               | Critical | High                      | Medium | Low   |
| ---------------------------------- | -------- | ------------------------- | ------ | ----- |
| A · Cache correctness & staleness  | 0        | 2                         | 1      | 0     |
| B · Token / auth hardening         | 0        | 0                         | 1      | 0     |
| C · UX / frustration observability | 0        | 1 (Orders PWA blind spot) | 2      | 1     |
| D · Business & legal protection    | 0        | 0                         | 1      | 1     |
| **Total**                          | **0**    | **3**                     | **5**  | **2** |

_(D1/D2 are non-code business action items and are excluded from the severity tally — they're listed separately below.)_

## Top gaps ranked by user-facing risk × business impact

1. **[High] Checkout-driven inventory decrement never invalidates the product cache** — `apps/api/src/services/order.service.ts:365-450, 765-790, 1206-1295`. No money leak (checkout re-validates live), but every sellout looks "in stock" to browsing customers for up to 120s — worst exactly when merchants care most (flash sales).
2. **[High] Product/price Redis cache never explicitly invalidated (only in-memory)** — `apps/api/src/lib/public-cache.ts:81-85`, `apps/api/src/services/product.service.ts:504-533`. A merchant's price fix is invisible to other Railway replicas for up to 120s. Reclassifies a known LOW/scaling finding as a price-integrity issue.
3. **[High] Orders PWA has zero client observability — no PostHog, no Sentry** — confirmed via repo-wide grep, `apps/orders/`. Compounds the 2026-07-02 "zero Sentry" finding; the fulfilment staff's UI is now confirmed doubly blind (errors AND behavior).
4. **[Medium] `getCached()` has no stampede protection** — `apps/api/src/lib/public-cache.ts:26-56`. Thundering-herd against Neon at every 120s TTL boundary on hot stores.
5. **[Medium] `wa-bridge.routes.ts:891` JWT verify has no algorithm/issuer/audience pinning** — inconsistent with every other verify call in the codebase; low exploitability today, real defense-in-depth gap.

## Quick wins (≤1 day) vs strategic (multi-day)

**Quick wins:**

- Add `invalidateCachedPrefix`/`invalidateCached` calls to the three inventory-mutation sites in `order.service.ts` (reuse `ProductService`'s existing invalidator).
- Pin `algorithms: ['HS256']` + `issuer`/`audience` on `wa-bridge.routes.ts:823` (sign) and `:891` (verify).
- Add a "Third-party services" bullet list to the privacy-policy fallback naming PostHog/Sentry/OneSignal/Resend/payment gateway.
- Get cyber-liability insurance quotes (D1) — pure procurement, not engineering.

**Strategic (multi-day):**

- Replace Redis product-cache invalidation with a `SCAN`-free pattern-delete (Redis `SET` of live key suffixes, or move to a keyspace-notification-driven bust) — closes the cross-replica staleness gap durably rather than just adding more `invalidateCachedPrefix` call sites that still don't touch Redis.
- Implement stale-while-revalidate or a lock-based single-flight in `getCached()` to close the stampede gap platform-wide (also benefits `featureService`).
- Decide and implement a sampled session-replay strategy (even 5-10% sampling, consent-gated) + wire Sentry↔PostHog session linking, closing C1+C2 together. Extend Sentry (already scoped as a 2026-07-02 follow-up) AND PostHog to `apps/orders` in the same pass.
- Produce the real `docs/business/vendor-liability-exposure.md` from actual vendor ToS/DPA documents (D2).

## Delta vs the 2026-07-02 MASTER audit

- **Reclassified, not new:** the Redis-not-cleared product-cache gap (`public-cache.ts:81-85`) was already logged as `2026-07-02-scaling-perf.md` finding #4, LOW/PLAUSIBLE, framed as a horizontal-scaling concern. This audit reframes it through the money/never-stale lens (it holds price), upgrades PLAUSIBLE→CONFIRMED (read the code directly, zero `redis.delete` hits for that key family), and raises severity to High.
- **Net-new, not in the 2026-07-02 finding set:**
  - Checkout-driven inventory decrement/restore never calling cache invalidation at all (`order.service.ts` — distinct root cause from the Redis-layer gap above; this is a total absence, not a partial one).
  - `getCached()` / `featureService.getStoreFeatures()` having zero stampede protection (previously only the general "cold-cache-stampede" scenario was flagged as an assumption in `scaling-perf.md`; this audit pinpoints the exact missing mechanism).
  - The `wa-bridge.routes.ts:891` JWT-verify inconsistency (algorithm/issuer/audience) — not covered by the 2026-07-02 `tenancy-rls-auth.md` or `security-surface.md` (grepped both for "algorithm"/"jwt.verify"/"wa-bridge" — zero hits).
  - PostHog session-replay being explicitly disabled + the Orders PWA having zero PostHog (the 07-02 audit flagged Orders PWA's zero-Sentry; this confirms the analytics side is equally absent — same root surface, previously unaudited vendor).
  - Both Lens D items (cyber-liability insurance, vendor-liability-cap documentation) — confirmed absent from all `docs/` content; genuinely outside the 10 lenses of the 07-02 audit.
  - The privacy-policy vendor-naming gap (D3) — the 07-02 audit's tenancy/PII lens covers GDPR mechanics (erase/export), not policy-copy accuracy against the actual analytics stack.

## Candidate new CLAUDE.md standing rule

**"Cache invalidation must cover every write path AND every storage layer, not just the primary one."** The two Lens-A findings share a root cause distinct from the existing rules: `invalidateCachedPrefix` exists and is called correctly by most writers, but (a) it only ever clears one of the two cache layers (in-memory, never Redis) and (b) at least one entire write path (order-driven inventory) was never wired to call it at all. Neither the existing "guard inside the transaction" rule nor "every paid feature enforced at the API layer" rule (both from 07-02) would have caught this — this is specifically about a cache invalidation helper being _partially_ wired (layer-incomplete) or _silently_ unwired (path-incomplete), which needs its own audit habit: **when adding any new write path to data that's cached, grep for every existing `invalidate*` call site for that data type and confirm the new path calls the same one(s)** — not just "does an invalidation call exist somewhere in this file."

## Non-code / business action items (Lens D)

- **D1 — Cyber-liability insurance.** Not present. ~$200-600/yr for $50k-$1M coverage is typical; FWB's security posture (per 07-02) should make underwriting straightforward. Owner: Ahmad. Action: get quotes, no engineering work required.
- **D2 — Vendor liability-cap documentation.** No `docs/business/vendor-liability-exposure.md` exists. The indicative table in this report is a skeleton only — needs the actual current ToS/DPA terms pulled for Neon, Railway, Cloudflare, Resend, PostHog, and MyFatoorah, with real cap figures recorded. Partially an engineering task (writing the doc) but requires Ahmad/business to source the actual agreements — flagged here as primarily non-code.

---

_Audit-only. No source modified. Builder Reality Audit v1 — derived from 4 founder-education reels (cache staleness, JWT hardening, session-replay/frustration observability, business/legal protection lenses)._
