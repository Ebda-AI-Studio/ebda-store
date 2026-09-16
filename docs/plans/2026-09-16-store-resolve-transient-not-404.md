# A transient store-resolve failure must not tell a shopper the store does not exist

**Status:** implementing. Scope approved by Ahmad 2026-09-16 — this fix ONLY.

This implements **F2** of `docs/plans/2026-09-15-storefront-concurrency-500.md`, whose Ruling S1
("no code change on the strength of this incident") deferred the decision rather than rejecting the
fix. F1 (`ProductDetailBody.tsx:139`, a 429 rendering as a 500 on the PDP) is **deliberately NOT in
this PR** — Ahmad chose not to change it today. Rate-limit values and the ZAP workflow are also
explicitly out of scope.

---

## 1. Current behaviour (verified in code on `origin/main` @ `6af9aa42`)

`apps/web/src/lib/store-resolver.ts`:

```ts
if (!response.ok) {
  console.error(`Failed to fetch store for domain ${logSafe(domain)}: ${response.status}`);
  return null; // ← 429, 500, 502, 504 … all land here
}
```

Both `fetchStoreByDomain` (~L245) and `fetchStoreBySlug` (~L398) collapse **every** non-OK response
to `null`. The outer `catch` does the same for network/timeout/JSON errors. `getStoreOrNotFound()`
(~L590) and `getStoreByTenantParam()` (~L640) then call Next's `notFound()` on `null`.

**Net effect: a rate-limited or briefly-unhealthy API is rendered to the shopper as a branded
404 "This page isn't available" — the store is reported as non-existent.** A 404 is also the one
status that tells Google to drop the URL, so a transient upstream blip is laundered into a
deindexing signal.

### Why this is reachable in production

`storeResolveLimiter` (`apps/api/src/middleware/security.ts:946`) is **30 req/min keyed on `req.ip`**.
The 2026-09-15 investigation measured that **Worker SSR subrequests are counted under the visiting
shopper's own IP**, not one shared Worker bucket (§4 of that plan). So the bucket that gets drained
is the shopper's own.

Observed `/public/store/resolve` 429 bursts in the 24h to 2026-09-15, **outside** any ZAP run:
09-14 15:1x (206), 09-15 02:4x (5), 06:3x (109), 10:2x (131), 10:3x (72).

**Attribution is UNVERIFIED and this PR does not claim otherwise.** Railway's HTTP log API
(`railway logs --http`) returned `Problem processing request` for every query, so client IP/ASN/UA
could not be read. Crawlers are the likely source; the case that would make it customer-facing is
**mobile-carrier CGNAT** (many Kuwaiti shoppers egressing from one IP), and that remains unproven.
This fix is justified by the _mapping_ being wrong regardless of who tripped it: "I could not reach
the API" is not "this store does not exist".

### The house pattern this restores

The repo already made exactly this distinction in three sibling fetchers — the store resolver is the
**outlier**, not the innovation:

```ts
// ProductDetailBody.fetchInitialProduct, BlogPostBody.fetchPost, BundleDetailBody.fetchInitialBundle
if (response.status === 404) return null; // definitive miss
if (!response.ok) throw new Error(`… failed: ${response.status}`); // transient → let it 500
```

---

## 2. Chosen mapping

| Upstream outcome                               | Classification  | New behaviour                            |
| ---------------------------------------------- | --------------- | ---------------------------------------- |
| HTTP **404** (`STORE_NOT_FOUND` / `NOT_FOUND`) | definitive miss | `null` → `notFound()` (**unchanged**)    |
| HTTP 200, `success:false`                      | definitive miss | `null` → `notFound()` (**unchanged**)    |
| HTTP 200, no `data.store`                      | definitive miss | `null` → `notFound()` (**unchanged**)    |
| HTTP **429**                                   | transient       | `throw StoreTemporarilyUnavailableError` |
| HTTP **5xx** (500/502/503/504)                 | transient       | `throw StoreTemporarilyUnavailableError` |
| Any other non-OK (400/401/403/408/…)           | transient       | `throw StoreTemporarilyUnavailableError` |
| Network error / timeout / abort                | transient       | `throw StoreTemporarilyUnavailableError` |
| Malformed body (`res.json()` throws)           | transient       | `throw StoreTemporarilyUnavailableError` |

**Only a 404 or a well-formed store-less 200 is a miss.** Everything else is transient. Both API
miss paths are genuine 404s — `/store/resolve` answers
`404 {success:false, error:{code:'STORE_NOT_FOUND'}}` and `/stores/:slugOrId` throws
`AppError(404,'NOT_FOUND')` — so the definitive signal is unambiguous and does not rely on body
shape.

A 400 will not succeed on retry, so "please retry" is imprecise for it. It is still classified
transient deliberately: a 400 from resolve means _our_ request was malformed, which is a platform
bug, and answering it with "this store does not exist" is a worse lie than "we're busy" — and unlike
the 404, it does not ask Google to deindex a real merchant.

---

## 3. Status codes — what Next 16 / OpenNext actually permits

**Verified against the installed `next@16.2.11` source, not assumed.**

`node_modules/next/dist/client/components/http-access-fallback/http-access-fallback.js`:

```js
const HTTPAccessErrorStatus = { NOT_FOUND: 404, FORBIDDEN: 403, UNAUTHORIZED: 401 };
const ALLOWED_CODES = new Set(Object.values(HTTPAccessErrorStatus));
```

**A page render can deliberately produce only 404, 403 or 401.** `forbidden()`/`unauthorized()`
additionally require `experimental.authInterrupts` (`forbidden.js` throws `E488` without it). There
is **no** supported way for a Server Component to emit **503** or set `Retry-After`; only Route
Handlers (`route.ts`) can set an arbitrary status, and no route handler in this fix's path needs one
(see §4 — `getStore()` stays lenient, so `/og`, `/manifest`, `/api/store-favicon` never throw).

**Therefore the chosen page-path status is 500, carrying a branded retry page** — not a bare 500,
and critically **not a 404**:

- Google treats 5xx as "come back later" and **retains** the URL; 404 is a deindexing signal. For the
  SEO half of this defect, 500 vs 503 is immaterial while 404 vs 5xx is the whole point.
- The error page leaks nothing: `app/error.tsx` is a client component that receives only
  `{message, digest}`, and Next replaces server `message` with a generic string in production.
- Rewriting 500→503 in the OpenNext Worker entry was considered and **rejected**:
  `scripts/cf-setup-local.sh` _generates_ `cache-worker-entry.ts`/`wrangler.jsonc` at build time, so
  the edit would be silently discarded on the next deploy — a gate that cannot survive its own build
  is worse than a documented residual.

**Residual, accepted:** the retry page is served as `500` with no `Retry-After`. Ruling SR-2.

### Never cached as a miss — verified, not assumed

`node_modules/next/dist/server/lib/patch-fetch.js:664`:

```js
if (res.status === 200 && incrementalCache && cacheKey && (isCacheableRevalidate || …)) {
```

Next's Data Cache **only writes `status === 200`**, so a 429/5xx resolve response is never stored and
never replayed for the `revalidate: 15` window. The in-process `storeCache` likewise only caches
successes (`if (store) storeCache.set(...)`). And an error render is not ISR-cached. So the transient
outcome cannot be frozen into a sticky 404 at any of the three layers.

---

## 4. Caller sweep

Every caller of the touched helpers, and what the new throw does to it:

| Caller                                                                                                                                                                      | Helper                                | Effect                                                                           | Action                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `app/layout.tsx` (render **and** `generateMetadata`)                                                                                                                        | `getStore()`                          | must never throw — it renders the chrome the 404/error pages live inside         | **`getStore()` stays lenient**: catches transient → `DEFAULT_STORE`    |
| `app/not-found.tsx`                                                                                                                                                         | `getStore()`                          | same                                                                             | unchanged by the lenient contract                                      |
| `app/manifest.ts`, `app/api/store-favicon/route.ts`                                                                                                                         | `getStore()`                          | same                                                                             | unchanged                                                              |
| `app/og/route.tsx`                                                                                                                                                          | `resolveStoreBySlug()` + `getStore()` | `resolveStoreBySlug` can now throw; the route's contract is "never throws"       | **wrapped in try/catch → falls back to `getStore()`**                  |
| `app/page.tsx`, `/products`, `/categories`, `/about`, `/contact`, `/faq`, `/bundles`, `/locations`, `/how-to-guides`, `/blog/[slug]`, `/products/[slug]`, `/bundles/[slug]` | `getStoreOrNotFound()`                | transient propagates → retry page instead of 404                                 | **intended behaviour change**                                          |
| `app/tenant-store/[tenant]/[locale]/**` (layout + 9 pages, incl. its `generateMetadata`)                                                                                    | `getStoreByTenantParam()`             | same                                                                             | **intended**; tree is dark-launched behind `STOREFRONT_TENANT_ROUTING` |
| `getStoreById()`                                                                                                                                                            | —                                     | 5 references, **all** in `store-resolver.ts` + its test; zero production callers | **unchanged** (Ruling SR-1)                                            |

### `generateMetadata` safety

- `layout.tsx::generateMetadata` calls the **lenient** `getStore()` → cannot throw. ✔
- `products/[slug]`, `blog/[slug]`, `bundles/[slug]` `generateMetadata` all call the **lenient**
  `getStore()` and already wrap their product/post/bundle fetch in try/catch. ✔
- `tenant-store/[tenant]/[locale]/layout.tsx::generateMetadata` calls `getStoreByTenantParam()`,
  which CAN now throw on a transient. That is consistent — the page beneath it throws for the same
  reason in the same render, so the outcome is one retry page, not a half-rendered store. Dark-launched.
- **The raw-vs-decoded trap is untouched**: `getStoreByTenantParam` still calls `decodeRouteParam`
  once, centrally, at its existing call site (`store-resolver.ts`). No param handling changes, so
  the Arabic-slug class (`feedback-nextjs-route-param-raw-vs-decoded`) cannot regress.

### A real miss must still 404 — and must still log

`apps/web/src/lib/__tests__/store-resolve-logging.test.ts` asserts all four `console.error` calls and
that an unresolvable domain logs **before** `notFound()`. Its three definitive-miss shapes
(200 `success:false`, 200 no-store, and `getStoreById` 503→null) are **untouched by design**, which is
why that file needs **zero edits** and is itself a regression gate for this change.

---

## 5. Out of scope — same class, reported not fixed

Per the approved scope these are **reported, not touched** (Ruling SR-3):

- `ProductDetailBody.tsx:139` — F1, explicitly excluded by Ahmad today.
- `lib/agent-store-resolver.ts` — `if (!res.ok) return null` in both fetchers. A 429 makes
  `/llms.txt` and `/.well-known/*` serve the **platform** document instead of the merchant's, or 404.
  Agent/bot-facing, not shopper-facing.
- `app/sitemap.ts` — `if (!res.ok) break` truncates the sitemap silently on a 429.

---

## 6. Test plan (TDD — red first)

New: `apps/web/src/lib/__tests__/store-resolve-transient.test.ts`

1. **429 on domain resolve → NOT `notFound()`** (throws `StoreTemporarilyUnavailableError`).
2. **503 on slug resolve → NOT `notFound()`**.
3. **Network error → NOT `notFound()`**.
4. **Malformed JSON → NOT `notFound()`**.
5. **API 404 → still `notFound()`** (the tenant-isolation invariant must not regress).
6. **200 `success:false` → still `notFound()`**, and still logs.
7. **`getStoreByTenantParam` 429 → NOT `notFound()`**; **404 → still `notFound()`**.
8. **`getStore()` (lenient) returns `DEFAULT_STORE` on 429** — never throws into the layout.
9. **A transient is never written to the in-process cache** (a 429 followed by a good response resolves).
10. **The error carries the `STORE_TEMPORARILY_UNAVAILABLE` digest** so `error.tsx` can key on it.

Plus the untouched `store-resolve-logging.test.ts` (7 tests) as the miss-path regression gate.

**Mutation checks (≥2):** revert `if (response.status === 404) return null` → the definitive-miss
tests must redden; revert the transient `throw` back to `return null` → the transient tests must
redden. Restore byte-identical both times.

**Gates:** `npm run lint`, `npm run typecheck`, the full CI unit set
(`npx vitest run tests/unit packages/shared/src packages/database/src apps/web apps/admin/src apps/orders`),
and `npm run build`.

---

## 7. Rollback

- Code-only change, no migration, no API change, no env var, no rate-limit change.
- `bash scripts/rollback.sh` (revert + push) → `cf-deploy.yml` redeploys the Worker; ~1–3 min.
- Or instant, no CI: `cd apps/web && npx wrangler rollback <previous-version-id>`
  (`npx wrangler deployments list --name force-web-cf-preview`).
- **Revert signal:** any 5xx on a normal storefront page that resolves fine by hand, a
  `checkout-monitor.sh` failure, or a `/health` commit that does not match the merge commit.

---

## 8. Rulings

> **Ruling SR-1 — `getStoreById()` keeps its `null`-on-any-failure contract.** It has zero
> production callers (all 5 references are the definition, its import in the test, and 3 test
> assertions), it is documented "for admin panel", and it is not on any shopper's 404 path. Its
> existing 503→`null` test is a deliberate regression gate I must not break.
> Cost if wrong: if a future admin surface adopts it, that surface inherits the same
> transient-as-miss bug — mitigated by the doc comment added at its definition.

> **Ruling SR-2 — the retry page ships as HTTP 500, not 503.** Next 16.2.11 permits only
> 404/403/401 from a page render (`ALLOWED_CODES`, quoted in §3), and the only place that could
> rewrite the status is a build-time-GENERATED Worker entry. The defect being fixed is
> "404 says the store does not exist"; 500 already fixes the deindexing and the shopper-facing lie.
> Cost if wrong: uptime/DAST tooling counts these as server faults rather than backpressure, which
> is exactly the F1 complaint — so this residual is inherited, not introduced.

> **Ruling SR-3 — the same bug in `agent-store-resolver.ts` and `sitemap.ts` is reported, not
> fixed.** Ahmad approved this fix only; both are bot-facing, not shopper-facing.
> Cost if wrong: crawlers keep seeing a platform document or a truncated sitemap during a 429 burst,
> which is an SEO cost with no customer impact, and is one small PR to close later.
