# A transient store-resolve failure must not tell a shopper the store does not exist

> **2026-11-10 follow-up:** the transient path now serves a stale-if-error copy first and answers 503 + Retry-After only when no safe copy exists; resolve caching moved out of the Next data cache into `store-resolve-cache.ts` (Ruling RESOLVE-BULLETPROOF-1, `docs/plans/done/2026-11-10-resolve-bulletproof.md`).

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
**mobile-carrier CGNAT** (many Egyptian shoppers egressing from one IP), and that remains unproven.
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

### The error boundaries are part of the change surface

**The first draft of this plan got this wrong, and the review caught it.** The table above
enumerated the callers of the resolver but not the `error.tsx` boundaries sitting between those
callers and `app/error.tsx`. Next dispatches a thrown error to the CLOSEST boundary above the
throwing segment, and three segment-level boundaries already existed — all of which destructured
`error: _error`, i.e. threw the error object away and rendered the generic body unconditionally:

| Boundary                        | Its page calls         | Was                 |
| ------------------------------- | ---------------------- | ------------------- |
| `app/products/error.tsx`        | `getStoreOrNotFound()` | discarded the error |
| `app/products/[slug]/error.tsx` | `getStoreOrNotFound()` | discarded the error |
| `app/bundles/[slug]/error.tsx`  | `getStoreOrNotFound()` | discarded the error |
| `app/cart/error.tsx`            | — (not today)          | discarded the error |
| `app/checkout/error.tsx`        | — (not today)          | discarded the error |

So on the PLP and the PDP — the two pages a shopper is most likely to reach from Google or a
WhatsApp link — the 404→500 half of the fix landed but the **shopper-facing half did not**: they
got "Something went wrong" instead of the retry copy.

The retry/generic branch therefore lives in the SHARED `components/RouteErrorFallback.tsx`, which
every boundary already renders, and `app/error.tsx` now delegates to it too rather than keeping a
second copy of the copy. Every boundary forwards `error`. This is CLAUDE.md platform rule 1 (a
change lands on every render path, not one) applied to error boundaries.

`global-error.tsx` is deliberately excluded: it replaces the whole document when the root layout
itself failed, so no provider is mounted and it cannot use the hook-based shared body.

**What this does NOT cover, stated plainly.** Only 3 of the 11 pages that call
`getStoreOrNotFound()` have a segment boundary that preserves chrome (`/products`,
`/products/[slug]`, `/bundles/[slug]`). The other 8 — including the storefront **homepage**, plus
`/categories`, `/bundles`, `/blog/[slug]`, `/about`, `/contact`, `/faq`, `/how-to-guides`,
`/locations` — fall through to the root boundary, which renders the shared body WITHOUT
header/nav/footer. The retry **copy** is now correct on all 11; the **chrome** is not. That gap is
pre-existing (the root boundary always rendered bare) and is accepted here rather than fixed, so
this section does not claim total coverage — Ruling SR-5.

**There is no `noindex` on the retry page.** An earlier draft rendered
`<meta name="robots" content="noindex,nofollow">` inside the fallback body and presented it as part
of the shipped fix. It was inert: `<meta>` hoisting into `<head>` is a React 19 feature and this
repo hard-pins react/react-dom to **18.3.1** in the root `overrides`, so the tag stayed in `<body>`
where Google ignores it. It has been removed; the indexing guard is the **HTTP 500** itself.
Ruling SR-4.

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

New: `tests/unit/web-error-boundaries-forward-error.test.ts` — the enumeration gate over the
boundaries, added after review found the nested-boundary miss:

11. Every `error.tsx` under `apps/web/src/app` is found (a positive control, so the gate cannot
    pass vacuously over an empty glob).
12. **No boundary discards its error as `_error`.**
13. **Every boundary that renders `RouteErrorFallback` passes `error={error}` to it.**
14. The digest predicate `isStoreTemporarilyUnavailable()` is true for the marker, false for an
    ordinary error, a lookalike digest, `undefined` and `null`.

Tests 11–13 assert on SOURCE TEXT — they prove each boundary FORWARDS the error, not that the page
renders. **This repo has no DOM harness** (no Testing Library, no jsdom — see the note in
`BundlesPageBody.test.tsx`), so the review's suggested render test is not available without adding
a dependency; the rendering decision is instead covered behaviourally by test 14 against the pure
predicate the component calls.

**Mutation checks — 7 run, 7 killed.** Source restored byte-identical (sha256 compared) after each:

| #   | Mutation                                               | Reddens                                                                                            |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| A   | delete `if (response.status === 404) return null`      | the definitive-miss tests                                                                          |
| B   | revert the transient `throw` to `return null`          | the 429 test and the digest test                                                                   |
| C   | put `error: _error` back in one boundary               | both enumeration-gate assertions, naming the file                                                  |
| D   | drop `error={error}` from one boundary                 | **`tsc`** — `TS2741: Property 'error' is missing … but required in type 'RouteErrorFallbackProps'` |
| E   | drop `transientResolveFailure: true` from the fallback | the lenient-resolver test                                                                          |
| F   | delete the layout's transient metadata branch          | the branch-order assertion                                                                         |
| G   | add a boundary that hand-rolls its own body            | the shared-body assertion, naming the file                                                         |

D is the important one: it proves the gate is the TYPE SYSTEM, not the regex. F guards branch ORDER —
the demo sentinel also matches the transient fallback, so if the two `if`s are ever swapped the retry
page silently goes back to being titled "Page not found — Ebda AI Studio".

**What the mutations do NOT prove:** that Next forwards a custom `digest` through the RSC payload in
a production build, and that `generateMetadata` emits the new title — neither is executable as a unit
test here (no DOM harness, no way to render `generateMetadata` in a test). Both are instead verified
outside the unit suite: the metadata half by a production render (§6.1), the digest half by a
headless-browser render (§6.3). §6.1 also records why the FIRST version of that verification claimed
the digest half on the strength of a grep that was matching its own `<meta>` description.

### 6.1 Rendered verification (the linchpin, executed not reasoned)

The entire user-visible deliverable hangs on two assumptions: that a digest set by the thrower
survives to the client error boundary, and that the layout's transient metadata branch is reached. If
either is false, every test here still passes, `tsc` still passes, and shoppers still see "Something
went wrong" — the PR would ship zero user-visible change and nothing would detect it. So it is
executed against a real production build rather than argued from Next's source.

**Executed 2026-09-16.** `NEXT_PUBLIC_API_URL=http://127.0.0.1:9/api/v1` (port 9 = discard, so every
resolve fetch is refused → the network-error branch of the transient mapping), `next build` then
`next start`, then `GET /demo-store`:

| Assumption under test                                  | Observed                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| The transient path fires at all (not a 404)            | **HTTP 500**                                                       |
| A thrower-set `digest` survives to the CLIENT boundary | **VERIFIED IN A BROWSER — §6.3**                                   |
| `generateMetadata` reaches the transient branch        | **`<title>Temporarily unavailable — please try again</title>`**    |
| The SEO guard is real and head-level                   | **`<meta name="robots" content="noindex, nofollow">` in `<head>`** |
| No multi-tenant leak                                   | **`Go Home`: 0 matches**                                           |
| The old claim is gone                                  | **`Page not found`: 0 · `isn't available`: 0**                     |

**CORRECTION — a first version of this section claimed the digest handoff was proven. It was not,
and the correction matters more than the original claim.** The evidence offered was a `grep` hit on
"busy right now", which comes from the `<meta name="description">` this very change adds — not from
the error body. Next does not server-render a production error UI: `<button>`, `Try Again` and
`Go Home` are absent from the HTML (0 matches each), and the document is byte-identical (22,432
bytes) before and after the Go-Home suppression, a change that would be visible had the body been in
the response at all. The error body renders on the CLIENT after hydration, so no curl-based check can
observe it. A grep matching a string the page legitimately contains for another reason is a check
answering the wrong question — the same class this plan documents elsewhere.

So `curl` proves the STATUS CODE and the whole METADATA branch, and can prove nothing about the body.
The body needed a browser — §6.3.

### 6.3 Client-render verification (headless Chromium)

Same forced-transient build, driven with Playwright's installed `chrome-headless-shell` (no new
dependency, no browser download), `GET /demo-store`, 4s after load:

| Assertion                                                     | Observed                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP status                                                   | **500**                                                                                                                                          |
| Retry body actually renders — **the digest handoff**          | **true** — "We're a little busy right now / This store is getting more requests than usual, so it could not load. Please try again in a moment." |
| "Try Again" control present                                   | **true**                                                                                                                                         |
| "Go Home" present                                             | **false** — the multi-tenant leak is gone                                                                                                        |
| Generic "Something went wrong"                                | **false**                                                                                                                                        |
| "Page not found" / "isn't available"                          | **false**                                                                                                                                        |
| Uncaught page errors (the new `useRouter` hook in a boundary) | **none**                                                                                                                                         |

**That closes the linchpin.** A thrower-set `digest` does survive Next's production RSC pipeline to
the client error boundary, so the branch this whole change hangs on is real and not an inference.
It also retires the `<button>`-absent puzzle from §6.1: the control was always there, just rendered
on the client.

Still NOT verified: the click itself (whether `router.refresh()` + `reset()` recovers once the API is
healthy again), and the OpenNext/workerd bundle — see the residual below.

**Residual, stated precisely:** this ran on `next start` (Node), NOT on the OpenNext/workerd Worker
that serves production. Under Next 16 on Node the status code, the metadata branch AND the
client-rendered retry body are all now measured (§6.1 + §6.3). ONE hop remains carried by inference:
that the OpenNext/workerd bundle preserves the same digest forwarding. Re-running the §6.3 probe
against a preview Worker closes it, and is the single highest-value follow-up to this work.

### 6.2 Two things the retry page must NOT do

- **No "Go Home" during a transient.** `getStore()` fell back to the demo sentinel, so `useStoreUrl`
  drops the `/<slug>` prefix and the link resolves to `/` — which on the platform host is
  `307 → ebda.app` (measured). That would walk a merchant's shopper onto the Force platform pitch,
  violating the HARD multi-tenant rule in `app/not-found.tsx`. The link is suppressed on that branch.
- **The title branch's real reach.** A page's own metadata export wins over the layout's, and nearly
  every store-resolving route exports a title, so the "Temporarily unavailable" title is visible
  chiefly on the HOMEPAGE — the same reach the old "Page not found — Ebda AI Studio" bug had. The
  `robots: noindex` half inherits everywhere. Ruling SR-7.
- **"Try Again" must actually retry.** Next hands the boundary the BARE `reset`, which only clears
  client error state and re-renders the SAME failed server payload — its own
  `client/components/error-boundary.js` keeps a separate `retry` that wraps `context.refresh()` and
  `reset()` in a transition. With "Go Home" suppressed, that button is the page's only control, so
  bare `reset` would make the retry page a dead end during the very outage it serves. The handler now
  mirrors Next's `retry`. **Not click-verified** — that needs a browser driving a live transient;
  the wiring is held by a source assertion in the gate. Ruling SR-8.

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
