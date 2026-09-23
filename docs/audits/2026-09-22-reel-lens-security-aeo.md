# FWB security + AEO audit — reel-derived lens

**Date:** 2026-09-22
**Repo:** `~/Desktop/projects/force-website-builder` @ `main` `f2af2cd2`
**Deployed = audited:** `curl https://api.force-ai.co/health` → `"commit":"f2af2cd29e41ff5019db061717818ce835a8356a"`, which is the `main` tip, so every code finding below describes what is live.
**Scope:** apps/web (storefront), apps/admin (`admin.force-ai.co`), apps/orders (`orders.force-ai.co`), apps/api (`api.force-ai.co`, Railway). Live hosts checked: pecannbee.com.kw, wadyaljuz.com, store.force-ai.co, admin.force-ai.co, orders.force-ai.co, api.force-ai.co.
**Mode:** read-only. No edits, commits, branches or deploys. Live checks used GET/HEAD only: no POST, no login, no password reset, no form submission. SQL ran against prod Neon (`crimson-king-40424588`) with `PGOPTIONS='-c default_transaction_read_only=on'` and ran SELECTs only.

## Method

1. Read `graphify-out/GRAPH_REPORT.md`. It is a community listing built from commit `34353bbf`, so it is stale and was used only for orientation.
2. Three parallel read-only sub-audits covered S1/S3/S4, S2/S5/S6/C1 and A1–A5. Each one read the code behind its grep hits and then measured the live system.
3. The parent re-checked every High finding directly against the source at `f2af2cd2` before recording it: S5 reset-token revocation, S3 status enforcement, A1 call sites, and the S2 carrier cache. It also measured the api.force-ai.co docs endpoints live.

## Tally

| Severity | Count | Items                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | 0     | —                                                                                                                                                                                                                                                                                                                                                                                                                      |
| High     | 3     | S5-1 revoked reset tokens still redeemable · S3-1 suspended/inactive status never enforced · A1 English meta description on every Arabic product/bundle page                                                                                                                                                                                                                                                           |
| Medium   | 6     | S2-1 decrypted carrier credentials cached in Redis · S5-2 reset TTL of 1h (target 15m) · S3-2 role change does not revoke the session · C1-1 no DPA · A3 no hreflang, no canonical on home, no English URL · A2 Organization missing `description`/`areaServed`                                                                                                                                                        |
| Low      | 9     | S1-1 localhost in prod frame-ancestors · S3-3 `x-store-slug` cookie has no explicit Secure · S4-1 webhook callback tenant-confusion residual · S5-3 reset rate limit looser than 3/h/account · S5-4 `/verify-email` has no limiter · S2-2 `dump.rdb` on disk at repo root · C1-2 "Last updated" is always today · A4-1 Pecannbee edge block defeats its own llms.txt · A4-2 llms.txt advertises category URLs that 404 |

---

## S1 — Clickjacking

**Admin, orders and API are clean: code and runtime agree.**

- Admin: `apps/admin/next.config.js:61` sets `X-Frame-Options: DENY`, and `CSP_SUFFIX` (`:43`) always ends in `frame-ancestors 'none'`. The per-route `frameSrc` only changes what admin may embed, which the page-builder preview needs. It never changes who may embed admin. Live `curl -sI https://admin.force-ai.co/` and `/login` both return `x-frame-options: DENY` and `frame-ancestors 'none'`.
- Orders: `apps/orders/next.config.js:60,89` uses the same pattern. Live `/` and `/login` confirm it.
- API: `apps/api/src/middleware/security.ts:1276` (XFO DENY) and `:1327` (`frame-ancestors 'none'`) are applied globally at `apps/api/src/index.ts:172` and override helmet's SAMEORIGIN default. Live on `/health` (200), `/api/v1/auth/me` (401) and a 404 path, all three carry both headers, so the error paths are covered too.

**The storefront is framable on purpose, and only by named origins.** `apps/web/next.config.js:94-101` removed X-Frame-Options on 2026-05-20 because Safari lets XFO override CSP, which broke the admin page-builder preview. CSP `frame-ancestors` (`:155-162`) is the gate: `'self' https://admin.force-ai.co https://app.forcemediakw.com http://localhost:3001 http://localhost:3000`. Live on pecannbee home, a pecannbee product page, a pecannbee 404, wadyaljuz home and wadyaljuz products, every response has no XFO and exactly that `frame-ancestors`. No arbitrary third party can frame the storefront. Checkout is served under the same storefront origin and inherits the same scoped policy, so it cannot be framed by third parties.

- **S1-1 Low, platform-wide.** Production `frame-ancestors` includes `http://localhost:3001 http://localhost:3000` (`apps/web/next.config.js:161`, the default when `STOREFRONT_FRAME_ANCESTORS` is unset). It is not remotely exploitable, but it is dev scope inside a production header. **Fix:** drop the localhost origins from the production default and add them only when `NODE_ENV !== 'production'`.

## S2 — Cache as a database (Redis)

- **Auth and network are clean.** The client is set up in `apps/api/src/services/redis.service.ts:1-56`. In dev, `docker-compose.yml` has `requirepass ${REDIS_PASSWORD:?…}`, which fails hard if the password is unset. The production URL shape is `redis://default:PASSWORD@*.railway.internal:6379` (`.env.production.example:99`), on Railway's private network. The repo's CLAUDE.md records that the public no-auth TCP proxy was removed on 2026-09-04. **This could not be re-verified live** because the private network is unreachable from outside.
- **No client-side exposure.** `grep -rn "NEXT_PUBLIC.*REDIS" apps/{web,admin,orders}/src` returns 0 matches. `apps/admin/src/hooks/useCurrentStore.ts` does not use Redis at all: it uses an in-process `Map` with a TTL (`:82-86`), so the recon premise was wrong there.
- **S2-1 Medium, platform-wide. Encrypted-at-rest credentials are cached in plaintext.** `apps/api/src/services/shipping-carrier.service.ts:54-79`: `getCarrierConfigs` reads `shippingCarrierConfig`, whose credentials are AES-256-GCM-encrypted in Postgres (`encryption.service.ts`). It decrypts them (`:71-74`) and then runs `redis.set(cacheKey, decrypted, 300)` (`:79`), key `shipping:carrier-configs:<storeId>`. So for a 5-minute window, Aramex/iCarry API keys sit in plaintext in the tier that was publicly exposed without auth until 2026-09-04. This is the lens's "cache treated as less sensitive than the DB" pattern exactly. **Fix:** cache the still-encrypted `credentials` blob and decrypt after the cache read, or don't cache it at all, since this is low-QPS admin config. The other caches were checked and are clean: CSRF nonces, JTI denylist, `user:tv`, MFA attempt counters, the layout-preview draft behind a 192-bit token, and product/store data. Store data has `agentApiKey` explicitly omitted, see `store.service.ts:214-216`.

  **Fixed 2026-09-23, and the fix itself carried a P1.** The cache now holds the
  still-ENCRYPTED rows and decrypts after every read. The first attempt changed the
  cached VALUE shape without changing the KEY, so surviving pre-fix entries were fed
  to `decryptCredentials` as objects for the full 300s TTL; it returned `{}`, which is
  indistinguishable from "no credentials", and the masked-resubmit merge then dropped
  and permanently overwrote the merchant's Aramex/iCarry secret. Closed by versioning
  the key (`:v2:`), reading the merge base straight from Prisma, and refusing the save
  instead of dropping an unresolvable masked field — see Ruling CRED-1. The identical
  shape in `notification-config.service.ts` was fixed in the same pass. Five guards
  recorded in `docs/security/defence-mutations.json`, all verified KILLED.

- **Dead surface (info).** `RedisService.setSession/getSession/...` (`redis.service.ts:109-137`) has 0 call sites.
- **S2-2 Low, local.** `dump.rdb` is at the repo root, 25.7 KB, dated Jun 13. It was never committed (`git log -- dump.rdb` is empty) and is ignored by `.gitignore:144`. It contains about 478 `cache:user:tv:<uuid>` / `cache:jti:deny:<uuid>` keys and no tokens, sessions or email addresses. They are still real user IDs sitting on disk. **Fix:** delete the file.
- Fail-open posture (info): lock, JTI-deny and MFA-counter calls return permissive values when Redis is down (`redis.service.ts:228`, documented at `middleware/security.ts:686-690`). This is a deliberate trade of strictness for availability. The consequence: during a Redis outage, a revoked JTI is honoured again until the `tv` fallback reads Postgres.

## S3 — Session fixation and the auth mechanism

Auth is custom JWT, not NextAuth. The access token is `token` (30 min, `apps/api/src/config/index.ts:87`) and the refresh token is `refresh_token` (365 days, stored in the DB). The only cookies ever set are at `apps/api/src/routes/auth.routes.ts:56,65`, both `httpOnly`, `secure` in prod and `sameSite:'none'`, which cross-origin use requires. Live: no `Set-Cookie` on any unauthenticated GET to admin `/`, admin `/login` or orders `/`. That matches the code, which only issues cookies from the POST login, MFA-verify and refresh routes.

**Clean:**

- Login always mints a new pair with a fresh `jti` (`auth.service.ts:489-624`), so there is no pre-auth identifier to fixate.
- Refresh rotates with family revocation when a token is reused (`:788-989`).
- CSRF tokens are bound to the principal (`middleware/security.ts:36-173`).
- Impersonation (`admin.routes.ts:1720-1842`) issues a separate 1h token with its own `jti` and an `impersonatedBy` claim, and `rejectImpersonated` (`middleware/auth.ts:246-266`) blocks irreversible actions while impersonating.
- There is no store-switch mechanism: grep for `switchStore` finds nothing, and store scope is checked on every request.

**Findings:**

- **S3-1 High, platform-wide. Suspended or inactive users keep full access.**
  - `PUT /admin/users/:id` accepts `status: 'active'|'inactive'|'suspended'` (`apps/api/src/routes/admin.routes.ts:573`) and audits the transition (`:647-649`). Nothing ever enforces it.
  - `login()` filters only `deletedAt: null` (`auth.service.ts:509-511`), so a suspended user can log in again with their password.
  - `refreshTokens()` never checks status, so open sessions keep refreshing.
  - `authenticate` never reads status.
  - Verified by the parent: grepping `suspended|status === 'active'` across `auth.service.ts`, `middleware/auth.ts` and `auth.routes.ts` finds only a comment (`auth.service.ts:1179`). The single real status check is on the MCP merchant-key path (`mcp/merchant-auth.ts:173`).
  - Why it matters: an admin who suspends a compromised or departing account believes it is locked out, and it is not.
  - **Fix:** reject non-`active` users in `login()`, `refreshTokens()` and `authenticate`'s tv path. In the `PUT` handler, call `AuthService.revokeAllSessions(id)` whenever status leaves `active`.
- **S3-2 Medium, platform-wide. A role change does not revoke the outstanding token.** The same handler (`admin.routes.ts:561-672`) never bumps `tokenVersion`, and `authorize()` trusts `role` from the JWT. A demoted user keeps the old role for up to 30 minutes. Refresh re-reads the role from the DB (`auth.service.ts:918-925`), so the exposure is bounded. **Fix:** call `revokeAllSessions` when `data.role !== existing.role`.
- **S3-3 Low, platform-wide.** The `x-store-slug` cookie (`apps/web/middleware.ts:341-347`) is `httpOnly`, `sameSite:'lax'`, with no explicit `secure`. It carries a public slug, not a credential. **Fix:** add `secure: true`.

## S4 — Open redirect

**No exploitable open redirect was found.**

- **`returnTo` on admin and storefront login.** `apps/admin/src/lib/auth.tsx:189-197` and `apps/web/src/app/auth/login/LoginClient.tsx:40-44` both pass the target through `safeInternalPath()` (`packages/shared/src/utils/safe-url.ts:81-96`). That function requires a leading `/`, which rejects `https:evil.com` and `%2F%2Fevil.com`. It rejects `//` and `/\` (`:87`) and any backslash (`:88`). It then re-resolves the path against a dummy origin and requires the origin to match (`:89-92`), so every requested variant is rejected. Live, `curl -sI "https://admin.force-ai.co/login?returnTo=https://example.com"` and `?returnTo=//evil.com` both return 200 with no `Location`, because the redirect happens client-side after login. Protection was therefore verified by reading the code, not by curl.
- **Payment `successUrl`/`errorUrl`.** `apps/api/src/routes/payment.routes.ts:22-61`: a Zod refine requires the origin to be `config.webUrl` or the path to be relative. At `:473-482`, a relative path is concatenated onto a server-derived `storefrontBaseUrl`, so `//evil.com` becomes `https://pecannbee.com.kw//evil.com`, a same-origin path. The other callback builders take no client input: `payment-links.routes.ts:~345`, `order.routes.ts:~1621`, `mcp/tools/order.tools.ts:~272` and `payment.factory.ts:1662`. The providers (`hesabe:144`, `tap:128`, `upayments:113`) only forward the validated values.
- **Locale switch.** There is no redirect parameter: `LanguageContext.tsx` sets a cookie and reloads the page.
- **Favicon redirect** (`apps/web/src/app/api/store-favicon/route.ts:33-38`). The target is a merchant-set, Zod-`.url()`-validated store field, not a request parameter.
- **S4-1 Low, platform-wide.** `webhook.routes.ts` `/payment/callback` (~733-782) and `/payment/error` (~806-819) look up the order by a client-supplied `transactionId` and redirect to that store's registered domain. The worst case is a redirect to another tenant's legitimate domain. **Fix:** also sign the callback or bind it to the origin store.

## S5 — Reset, magic-link, invite and verification tokens

The schema is `packages/database/prisma/schema.prisma`: `RefreshToken` (line 119) and `VerificationToken` (line 142). Password reset reuses `RefreshToken` rows with a `reset:` prefix. There is no magic-link login.

- **Email verification is clean.** `auth.service.ts:291-425`: `randomBytes(32)`, stored as a sha256 hash, 24h expiry, single use through `usedAt`, and the raw token is never logged.
- **S5-1 High, platform-wide. Revoked reset tokens can still be redeemed.** Parent-verified at `f2af2cd2`:
  - `resetPassword` (`auth.service.ts:1254-1260`) looks the token up with only `{ token: 'reset:<hash>', expiresAt: { gt: now } }` and never checks `revokedAt: null`.
  - `revokeAllSessions` (`:1171-1174`), which runs on both `changePassword` (`:1138`) and `resetPassword` (`:1292`), revokes by setting `revokedAt` on every row, reset rows included.
  - As a result, revocation does not actually stop an outstanding reset link. Two exploits follow:
    - A victim changes their password, and an attacker holding a still-live reset link (forwarded mail, shared inbox or device) resets it anyway and takes the account.
    - When several reset emails are outstanding, redeeming one "revokes" the others, which still work.
  - **Fix (one line):** add `revokedAt: null` to that `where`, the same check the refresh path already makes (`:807`). A stricter version also deletes `reset:` rows in `revokeAllSessions`.
- **S5-2 Medium, platform-wide.** The reset TTL is 1 hour (`:1219`) against the 15-minute target. **Fix:** use `15 * 60 * 1000` and change the email copy (`expiresIn: '1 hour'`, `:1239`) to match.
- **Single use (clean).** The consumed row is deleted (`:1276-1278`).
- **Hashed (clean).** Stored as sha256.
- **No enumeration (clean).** An unknown email returns silently, and the lookup is tenant-scoped (`authScope`).
- **Not logged (clean).**
- **S5-3 Low, platform-wide.** `/forgot-password` and `/reset-password` use `authLimiter` at 15 requests per 15 minutes per IP+email (`middleware/security.ts:655-698`, deliberately raised from 5), against the 3/hour/account target. The per-account lockout covers password guessing but not reset-email flooding. **Fix:** add a dedicated limiter of 3/hour keyed on the normalised email.
- **S5-4 Low, platform-wide.** `/verify-email` (`auth.routes.ts:892`) has no limiter. The token is 256-bit and hashed, so brute force is infeasible; this is a consistency gap only.
- **Invites (info).** There is no invite-token flow. `staff.routes.ts:82-183` creates the user directly. When no password is supplied, a random one is generated (`:118`) that is never returned or emailed, so the invitee has to discover "forgot password". This is a UX gap, not a token defect.

## S6 — API schema exposure

- **Swagger/OpenAPI is gated off in production and verified live.** `apps/api/src/docs/swagger.ts:402-406` returns early when `NODE_ENV === 'production'`. Live: `api.force-ai.co/docs`, `/docs/openapi.json`, `/api-docs` and `/graphql` all return 404. The admin, store and orders hosts return 404 for `/api/docs`, `/swagger`, `/openapi.json` and `/graphql`.
- **No GraphQL anywhere.** The only grep hits are `tsconfig.tsbuildinfo` artifacts.
- **No production source maps.** Three real chunk URLs per host on admin, store and orders were each fetched with `.map` appended, and every one returned 404.
- **Error bodies are clean without needing an env guard.** `apps/api/src/middleware/error-handler.ts`:
  - Unknown errors always return `{code:'INTERNAL_ERROR', message, requestId}` and log the details server-side (`:191-199`).
  - Prisma errors map to an allowlisted field-label translation (`:108-119`), and the raw code, meta and message never reach the client.
- **Health endpoints are minimal.** Admin and orders `/health` return `{"status":"ok","service":…}`. API `/health` exposes `commit` + `deploymentId` on purpose, for deploy verification. That is an accepted, narrow disclosure.
- **Info.** An unknown API route returns Express's default `Cannot GET /x` HTML, which fingerprints Express. **Fix (optional):** add a JSON 404 catch-all.

## C1 — Compliance

- **Privacy and terms exist and are linked, live 200 on all three commerce hosts.** `/privacy` and `/terms` return 200 on pecannbee.com.kw, wadyaljuz.com and store.force-ai.co.
  - The model is hybrid: one FWB-authored fallback (`apps/web/src/app/privacy/PrivacyClient.tsx:8-11`, `terms/TermsClient.tsx`), which a merchant can override through a Pages-CMS `privacy`/`terms` row. Pecannbee is currently on the fallback.
  - Both pages are linked from the footer (`apps/web/src/components/ui/flickering-footer.tsx:408,414`).
- **C1-1 Medium, platform-wide. No data processing agreement exists.** In this B2B2C model, FWB processes shopper PII on behalf of merchant controllers (GDPR Art. 28; Kuwait Law 13/2023 analogue).
  - `find docs -iname "*dpa*" -o -iname "*data-processing*"` returns nothing.
  - The only mentions are open-gap notes, not a document: `docs/superpowers/plans/2026-05-15-iceberg-audit-followup.md:85,323,348` ("blocks … merchant #2+") and `docs/audits/2026-07-09-builder-reality-audit.md:154,207,226`.
  - `docs/business/vendor-liability-exposure.md` covers FWB's own upstream vendors' DPAs (Neon, Railway, Resend, PostHog), not FWB→merchant.
  - It has been flagged twice and is still open.
  - **Fix:** a one-page standard DPA with these parts:
    - the subprocessor list, already enumerated in `vendor-liability-exposure.md`;
    - a breach-notification SLA;
    - deletion and export terms, which the `/auth/me/erase` and `/auth/me/export` endpoints already implement;
    - acceptance recorded at merchant onboarding.
- **C1-2 Low, platform-wide.** "Last updated" renders `formatDate(new Date())` (`PrivacyClient.tsx:26`, `TermsClient.tsx:25`), so it always shows today's date and falsely attests that the policy is current. **Fix:** hard-code a real review date, or use the CMS row's `updatedAt`.

## A1 — Locale-matched meta (root cause)

**Verdict: (b), a code bug. Platform-wide. High severity for AEO: every Arabic-default store serves English meta descriptions on every product and bundle page.**

- `apps/web/src/lib/seo/meta-description.ts:7-32` is correct. With `locale === 'ar'` it returns only `metaDescriptionAeoAr → metaDescriptionAr → descriptionAr`.
- The call sites never pass a locale, so the default `'en'` always wins (parent-verified with `grep -rn "pickMetaDescription("`):
  - `apps/web/src/app/products/[slug]/ProductDetailBody.tsx:73`: `pickMetaDescription(product) || product.description`
  - `apps/web/src/app/bundles/[slug]/BundleDetailBody.tsx:63`: `pickMetaDescription(bundle) || bundle.description`
  - `apps/web/src/app/manifest.ts:115`: `pickMetaDescription(store)`. This is the same bug class; the PWA manifest description is English.
  - Correct counterexample: `apps/web/src/lib/storefront-metadata.ts:29-35` (home) derives `preferAr` from `store.settings.defaultLanguage` and passes it.
- `buildProductMetadata` and `buildBundleMetadata` take no locale parameter at all. They are called from `generateMetadata` in `products/[slug]/page.tsx:54` and in the dark-launched `tenant-store/[tenant]/[locale]/products/[slug]/page.tsx:41`, which has `locale` in its route params and still drops it.
- `<html lang>` is resolved separately in `apps/web/src/app/layout.tsx:144-173` (the `force-language` cookie, then the store default). That is why `lang="ar"` and an English description appear together.

**SQL evidence (prod, read-only):**

```sql
SELECT id, name, slug, domain FROM stores
WHERE domain ILIKE '%pecannbee%' OR domain ILIKE '%wadyaljuz%';
-- dfc1c208-… | Wady Aljuz | wady-aljuz | wadyaljuz.com
-- 359afc1f-… | Pecannbee  | pecannbee  | pecannbee.com.kw

SELECT s.slug, count(*) total,
  count(*) FILTER (WHERE p.meta_description_aeo_ar IS NOT NULL) aeo_ar_nonnull,
  count(*) FILTER (WHERE p.meta_description_aeo_ar IS NOT NULL AND p.meta_description_aeo_ar !~ '[؀-ۿ]') aeo_ar_no_arabic,
  count(*) FILTER (WHERE p.meta_description_ar IS NOT NULL) meta_ar_nonnull,
  count(*) FILTER (WHERE p.meta_description_ar IS NOT NULL AND p.meta_description_ar !~ '[؀-ۿ]') meta_ar_no_arabic,
  count(*) FILTER (WHERE p.description_ar IS NOT NULL) desc_ar_nonnull,
  count(*) FILTER (WHERE p.description_ar IS NOT NULL AND p.description_ar !~ '[؀-ۿ]') desc_ar_no_arabic
FROM products p JOIN stores s ON s.id = p.store_id
WHERE s.id IN ('359afc1f-ea5b-4f8d-b372-c038c6c057f7','dfc1c208-1c30-4eba-9821-6f3be15e3506')
  AND p.deleted_at IS NULL GROUP BY s.slug;
--  store      | total | aeo_ar_nonnull | aeo_ar_no_arabic | meta_ar_nonnull | meta_ar_no_arabic | desc_ar_nonnull | desc_ar_no_arabic
--  pecannbee  |  210  |      206       |        0         |       210       |         0         |       158       |        0
--  wady-aljuz |  231  |      231       |        0         |       231       |         0         |       231       |        0
```

No non-null Arabic column contains non-Arabic text, so the sweep did not write English into the `*Ar` columns. Smoking-gun row, `schools-offer`:

- `meta_description_aeo` = "Pecannbee's School's offer features the 30 KD Diversity Package: four 250g jars…"
- `meta_description_aeo_ar` = "عرض العودة للمدارس من بيكان بي يوفر باقة التنوع بـ 30 ديناراً…"

Live `curl -s https://pecannbee.com.kw/products/schools-offer` returns `<html lang="ar" dir="rtl">` with `<meta name="description" content="Pecannbee's School's offer features the 30 KD Diversity Package…">`, a byte-for-byte match of the English column. Wady Aljuz `/products/barley` has the same shape, so this is platform-wide, not one merchant's data. Separate data-completeness note: Pecannbee has 4 NULL `meta_description_aeo_ar` and 52 NULL `description_ar`.

**Fix:**

1. Add a `locale` parameter to `buildProductMetadata` and `buildBundleMetadata`.
2. Resolve the locale in each `generateMetadata` with one shared helper extracted from `storefront-metadata.ts` (the store default, then the `force-language` cookie), or from the `[locale]` param in the tenant-store tree.
3. Pass it to `pickMetaDescription`.
4. Apply the same to `manifest.ts:115`.
5. Localise the `|| product.description` fallback as well. With the locale fixed, an empty Arabic chain would still fall back to English. Use `|| (ar ? product.descriptionAr : product.description)`.
6. Add a test asserting that an AR-default store's product metadata description matches `[؀-ۿ]`.

## A2 — Brand entity

Builder: `apps/web/src/lib/structured-data.ts:257-302`. Live on pecannbee.com.kw `/`, it emits `name`, `url`, `logo`, `email`, `telephone`, `sameAs` [tiktok, instagram], plus non-schema keys (`region`, `currency`, `location`, `languages`, `keyCategories`, `contactMethods`) merged from `store.aboutJson` (`:300`).

- **`sameAs` is present and merchant-editable.** `store.socialLinks` (`schema.prisma:222`) supports instagram, linkedin, wikidata, wikipedia and others, edited in `apps/admin/src/app/stores/[id]/branding/_components/SocialLinksTab.tsx`.
- **A2 Medium, platform-wide.** `description` and `areaServed` are never emitted under any input.
- **`address`:** the code path exists (`:286-293`) and the admin field exists (`ContactInfoTab.tsx:69-72`), but Pecannbee's `store.address` is empty. That is merchant data, not code.
- **Fix:**
  - Emit a locale-correct `description`, reusing the A1 locale helper.
  - Emit `areaServed`, from store config or defaulting to Kuwait/GCC.
  - Move the `aboutJson` extras under `additionalProperty` or drop them.
  - Merchant action: fill in Pecannbee's address.

## A3 — hreflang and canonical

**A3 Medium, platform-wide.**

- **Canonical.** It is emitted on product (`ProductDetailBody.tsx:106`), bundle (`BundleDetailBody.tsx:87`) and blog (`BlogPostBody.tsx:85`) pages. It is missing on home: there is no `alternates` in `storefront-metadata.ts` or `layout.tsx`, and live `/` has no `<link rel="canonical">`.
- **hreflang.** It exists nowhere: `grep 'hreflang|alternates.*languages' apps/web/src` returns 0 matches, and the live home and product pages have none.
- **English URL shape.** None exists in production. Language is a cookie toggle on the same URL. The `/…/[locale]/…` tree under `tenant-store` is dark-launched behind `STOREFRONT_TENANT_ROUTING === 'true'` (`apps/web/middleware.ts:143`), which is off. Live: `https://pecannbee.com.kw/en/products/schools-offer` returns **HTTP 404**, served by the FWB app (`x-store-domain` present), with a `lang="ar"` shell and the store-wide Arabic fallback description.
- **Fix:**
  - Now: add `alternates.canonical` to home, and to category pages if they lack it.
  - Later, as a product decision: hreflang has nothing to point at until English URLs exist. Either enable the `[locale]` routing and then emit `alternates.languages` {ar, en, x-default}, or document the cookie-only design as a deliberate AEO ceiling.

## A4 — AI crawler policy

- **No code-level policy.** `apps/web/src/app/robots.ts` has one rule, `userAgent:'*'`, allow `/`, disallowing `/account/ /checkout/ /cart/ /auth/ /affiliate/`, with no bot branching. Grepping `GPTBot|ClaudeBot|CCBot|aiCrawler|robots_policy` across web, admin and the schema finds 0 matches. There is no merchant-facing control.
- **`llms.txt` is a real feature.** `apps/web/src/app/llms.txt/route.ts` serves a platform index, per-store output on the platform path and per-store output on custom domains, with a merchant override (`store.llmsTxt`). It is live and populated on pecannbee and store.force-ai.co.
- **The Pecannbee block is a Cloudflare zone rule, confirmed.**
  - On pecannbee.com.kw, GPTBot, ClaudeBot and CCBot get **403** with body "Your request was blocked." That response carries no app headers (no `x-store-domain`, no CSP), only `server: cloudflare`.
  - On the same host, Googlebot and the default UA get 200.
  - With the same UAs, wadyaljuz.com returns 200 and store.force-ai.co returns 307, the same as Googlebot.
  - Identical code behaving differently per domain means this is edge configuration on that zone.
- **A4-1 Low, Pecannbee config.** The edge block stops AI crawlers before they reach the llms.txt and AEO copy FWB built for them, so the two investments contradict each other. **Fix:** decide deliberately. For example, allow the answer-engine and search agents (OAI-SearchBot, ClaudeBot-search, PerplexityBot) and keep blocking training-only crawlers. Record the ruling. If per-merchant policy is wanted, it is a feature gap in admin.
- **A4-2 Low, platform-wide.** Pecannbee's `llms.txt` advertises `/categories/honey-and-olive-oil` and `/categories/dragee`, and both 404 live. The generator emits category slugs without checking that the route resolves. **Fix:** build category links from the same resolver the storefront uses, and add a test that every llms.txt link returns 200.

## A5 — Thin content

**The specific concern is clear.** The product description is server-rendered as visible text, not only in JSON-LD. `apps/web/src/app/products/[slug]/ProductDetailClient.tsx:456-460` picks `descriptionAr` for Arabic and renders it at `:746-754` inside `<p class="mt-6 max-w-prose whitespace-pre-line …">`. Live raw HTML for `/products/schools-offer` (no JS) contains the full Arabic paragraph.
**The page is still genuinely short.** Visible text on `/products/schools-offer` is about 722 characters: breadcrumb, H1, price, description and controls. The review and FAQ blocks render only when data exists (`ProductDetailBody.tsx:192-241`). This is a content-volume property of the template, not a rendering defect. **Lever:** fill in specs, origin, usage and FAQ per product, with the AEO sweep as the delivery vehicle, rather than changing code.

---

## Could not verify, and why

1. **Railway Redis is still private and password-only.** The internal network is unreachable from outside, and no Railway dashboard or API was used. It would be settled by `railway variables` on the Redis service plus confirming that no TCP proxy is listed.
2. **S3-1 and S5-1 end to end.** Both are proven by reading the code only. Exercising them needs a login, a password change or a reset against a real account, which is forbidden in prod. A staging account or a unit test would settle it: for example, `resetPassword` should throw after `revokeAllSessions`, and `login` should throw for a `suspended` user.
3. **Whether any merchant has ever authored a CMS privacy or terms page.** Only Pecannbee's current state was checked, and it is on the fallback.
4. **The S4 client-side `returnTo`.** It cannot be observed over an unauthenticated GET because the redirect fires after login. It was verified by reading `safeInternalPath` only.
5. **Wady Aljuz's edge policy beyond GPTBot and ClaudeBot.** Only those UAs were sampled.

## Prioritized fix list

1. **S5-1 (High).** Add `revokedAt: null` to the `resetPassword` lookup (`auth.service.ts:1254-1260`), plus a regression test. One line.
2. **S3-1 (High).** Enforce `status === 'active'` in `login`, `refreshTokens` and `authenticate`, and call `revokeAllSessions` on any status change away from active (`admin.routes.ts:561-672`).
3. **A1 (High).** Thread the locale into `buildProductMetadata`, `buildBundleMetadata` and `manifest.ts`, using one shared resolver, and localise the fallback. Measure live afterwards on pecannbee and wadyaljuz, checking that an Arabic description appears under `lang="ar"`.
4. **S3-2 (Medium).** Revoke on role change, in the same handler as #2.
5. **S2-1 (Medium).** Stop caching decrypted carrier credentials.
6. **S5-2 and S5-3 (Medium/Low).** Set the reset TTL to 15 minutes and add a 3/hour per-email reset limiter.
7. **A3 (Medium).** Add a canonical on home now, and log a ruling on English URLs and hreflang.
8. **A2 (Medium).** Add `description` and `areaServed` to Organization, and have the merchant fill in Pecannbee's address.
9. **C1-1 (Medium).** Draft a standard DPA and record acceptance at onboarding.
10. **A4-1 and A4-2 (Low).** Decide Pecannbee's AI-crawler rule, and fix the dead category links in llms.txt.
11. **Low cleanups:**
    - S1-1: remove localhost from the production frame-ancestors.
    - S3-3: add Secure to `x-store-slug`.
    - C1-2: show a real "Last updated" date.
    - S5-4: add a limiter to `/verify-email`.
    - S4-1: bind the webhook callback to its store.
    - S2-2: delete `dump.rdb`.
    - Info: add a JSON 404 on the API.
