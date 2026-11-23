I explored the real repo (not the stale worktree) and the branch `fix/perf-vibecode-lens`, which already contains the audit doc and a partial fix (R2 incremental cache wiring). I could not write the plan file myself — I'm a read-only planning agent with no file-write tool — so the full plan is below; please have the orchestrating session persist it to `/private/tmp/claude-501/-Users-ahmadsharaf/971fc5a9-e2a9-4ce4-84a9-b644d26509fb/scratchpad/tenant-cacheable-routing-plan.md` (or `docs/plans/done/2026-07-12-tenant-cacheable-routing.md` on the branch, since that root isn't actually read-only from the worktree).

## Executive summary (10 lines)

1. `apps/web/src/lib/store-resolver.ts`'s `getStore()`/`getStoreOrNotFound()` call `headers()` internally, and `app/layout.tsx` independently calls `headers()` (host, GSC-token branch) and `cookies()` (language, consent, draft-preview) — both poison every storefront route into per-request dynamic rendering, so the R2-backed incremental cache (once actually live — see risk below) never serves full HTML.
2. Fix is NOT "just delete headers()" — Next's Full Route Cache keys by pathname only, and this Worker serves every custom domain + the platform-slug path from ONE deployment, so naive ISR would leak store A's HTML onto store B's domain. Tenant (and locale) must become part of the matched pathname via a middleware rewrite, with the visible browser URL unchanged.
3. Target: middleware rewrites anonymous-surface requests (home/PLP/PDP/categories/blog/static pages) into a new `/_store/[tenant]/[locale]/...` segment tree where pages read `params` instead of `headers()`/`cookies()`; personalized routes (cart/checkout/account/auth/wishlist/compare/search/review) are left on their existing flat, header-based, explicitly `force-dynamic` paths — untouched, zero regression risk there.
4. `generateStaticParams` must NOT be used to enumerate tenants/paths at build time (the `feedback-migrate-before-deploy-and-force-dynamic` lesson: never couple a dynamic-API route's render mode to build-time DB reachability) — use `dynamicParams: true`, no `generateStaticParams`, on-demand ISR only.
5. PPR/`cacheComponents` (Next 16.2.6 is installed, neither flag is enabled) is evaluated and deliberately deferred to a Phase-3 spike — it doesn't remove the tenant-in-cache-key requirement and OpenNext-Cloudflare's support level here is unverified in this session.
6. Root-layout decomposition is the hardest single piece: consent-gating (legal requirement) and the admin page-builder live-preview iframe both currently rely on unconditional server-side `cookies()`/`headers()` reads in the shared layout — the plan routes preview traffic (`?_preview=`) around the new cacheable tree entirely (keeps the existing dynamic code path verbatim) and requires an explicit sign-off decision on adapting consent-gating to a client-side-first-check pattern.
7. Invalidation has a real, concrete gap today: `scripts/cf-setup-local.sh` (run by `cf-deploy.yml` on every deploy) regenerates `open-next.config.ts`/`wrangler.jsonc` from scratch keyed off the `OPENNEXT_CACHE` repo variable — the hand-edited R2 wiring on this branch (commit `0235b9dc`) may be silently clobbered, and `revalidateTag` is per-isolate unless the DO-sharded tag cache (already coded, gated behind that same flag) is also live. This must be verified as a Phase 0 gate before shipping any full-page ISR.
8. Client-store pixel parity (wady-aljuz, demo-store) is preserved by construction — this redesign changes only WHERE rendering happens (route/segment structure, cache key), never WHAT renders; no template/component markup changes.
9. Rollback is cheap at every step: Cloudflare Worker deploys are atomic, `wrangler rollback`/`git revert && push` (existing `scripts/rollback.sh`) instantly reverts; the migration is also flag-gatable (env var to skip the new middleware rewrite branch, falling back to today's header-only path with zero code path removed).
10. Biggest risk: cross-tenant cache poisoning if the rewrite-to-route-param step ships before the cache-key-is-pathname invariant is fully verified in a CF preview environment across both domain modes — this is a correctness bug, not a perf regression, and must be gated behind an explicit multi-tenant preview verification step, not just unit tests.

**Biggest risk:** shipping the route-param rewrite with any code path that still resolves store/theme from `headers()`/`cookies()` inside the "cacheable" tree (e.g. a missed call site, or the preview-draft/consent logic leaking back in) — Next would then either (a) silently re-force dynamic (safe, just no perf win) or (b) worse, if a _future_ PPR/cacheComponents change makes the page "look" static while a stray header read still executes, serve one tenant's cached HTML to another tenant's domain. Root cause is architectural (single shared Worker, cache keyed by pathname only) — mitigated by making the rewrite the ONLY place any dynamic API is legitimately read (isolated to `middleware.ts`), and by a mandatory two-domain-mode E2E cache-hit/no-cross-contamination test before every promotion.

**Estimated scope:** Large — not a quick win. ~10-14 files touched directly (`middleware.ts`, `store-resolver.ts` split, `app/layout.tsx` decomposition + a new nested layout, `generateMetadata`/`robots.ts`/`sitemap.ts` host-detection call sites, ~9 page files moved under the new segment, `revalidate-storefront.ts` + `product.service.ts`/`category.service.ts` tag wiring, `cf-setup-local.sh`/`wrangler.jsonc` cache-config reconciliation), plus every internal `<Link>`/href-building call site that goes through `useStoreUrl()` (75-edge god node) needs an audit pass. Realistic sizing: 5-7 sequenced PRs over ~2-3 weeks for one engineer+agent pair, gated by CF-preview verification between each, not a single PR.

---

# Tenant-Cacheable Storefront Routing — Implementation Plan

_(2026-07-12, branch `fix/perf-vibecode-lens`)_

## 0. Grounding corrections (read this first)

- The audit path given (`docs/audits/2026-07-12-perf-vibecode-lens.md`) doesn't exist on `main` in the read-only root — it exists on **branch `fix/perf-vibecode-lens`**, which is the branch this exact worktree (`ebda-store__fix-perf-vibecode-lens`) is for. Its "claim 3" (not 5) is the R2/ISR cold-cache finding; the explicit guardrail note in that doc says: _"`headers()` stays in the store-resolver... that redesign is planned work, out of scope here."_ This plan is that follow-up work.
- The line numbers in the task prompt (`store-resolver.ts:188-204`) don't match current code — the actual `headers()` calls are `getStoreDomain()` (line 187-190), `getStoreSlug()` (195-198), `isPlatformDomain()` (203-206), all used internally by `getStore()`/`getStoreOrNotFound()` (~line 500-560). Same defect, different line numbers.
- "PR #694" doesn't exist under that number; the real, relevant commits are `e2827661` (`feat(cf): flag-gated opennext r2 + sharded-do revalidatetag cache (#433)`) and `0235b9dc` (`fix(web): wire r2-backed opennext incremental cache`, on this branch). See §2.7 — there's a real gap between what's committed and what's actually deployed.

## 1. Problem, restated precisely

Every storefront page (home, PLP, PDP, categories, blog, static content) calls, directly or transitively, a Next Dynamic API (`headers()`, `cookies()`, or a read `searchParams` prop) somewhere in its render chain. Per Next's rules, using a Dynamic API anywhere in a route's layout chain forces that ENTIRE route to render dynamically per request — so even with a working persistent incremental cache (R2), zero full-page HTML is ever cached; only `fetch()`-level data-cache entries (the `next: { revalidate: 60, tags: [...] }` calls already present in `store-resolver.ts` and each page) get the benefit.

## 2. Current architecture — verified findings

### 2.1 Tenant resolution today (`apps/web/middleware.ts`)

- **Custom domain** (wady-aljuz, demo-store): `getStoreIdentifier(hostname)` returns the normalized host; middleware sets `x-store-domain` header, does **not** rewrite the path. `store-resolver.getStore()` reads that header via `headers()`.
- **Platform domain, path-based** (`store.ebda.app/<slug>`): middleware **already rewrites** the path (`extractStoreSlug` strips the first segment, `NextResponse.rewrite()` to the remaining path) and sets `x-store-slug` header + a 30-day cookie (`x-store-slug`) so slug survives subroute navigation without the URL segment.
- **Platform bare root / no slug in URL**: falls back to the `x-store-slug` cookie.
- This means the codebase **already has a working precedent for rewrite-based tenant carrying** — the missing piece is that the tenant identifier lands in a _header_, not in the _matched pathname_, so it never participates in Next's cache key.

### 2.2 CF-for-SaaS custom-domain routing

`docs/merchant/custom-domain.md` + `apps/web/wrangler.jsonc`: merchants CNAME to `cf.ebda.app`; `wrangler.jsonc` routes both `cf.ebda.app` (custom_domain) and `*/*` on zone `ebda.app` to the **same** Worker (`force-web-cf-preview`). Confirms: **one Worker instance serves every merchant's custom domain simultaneously**, differentiated purely by the `Host` header at request time. This is the load-bearing fact behind the whole redesign — any cache Next builds must be keyed by more than pathname alone, or two merchants' pages collide.

### 2.3 Theme CSS injection (`app/layout.tsx`)

`RootLayout` (server component) does, all in the same shared layout that wraps every route:

- `getStore()` (→ `headers()`)
- `headers()` again directly, for `requestHost` (GSC-token custom-domain-vs-platform branch, line ~127)
- `cookies()` for `force-language` (locale), `force-preview-draft` (admin page-builder live preview), `force-cookie-consent` (SSR marketing-pixel gate)
- Builds the `themeStyleTag` (`:root { --var: value }`) from `store.theme`, sanitized via `sanitizeThemeColor`/`sanitizeCssValue`

Every one of these is a _legitimate_ per-request concern today, but because they all live in the ONE shared root layout, they poison every route, including the ones that don't need any of it (home/PLP/PDP just need theme + store, not consent/draft/host-branch logic ideally scoped only to metadata generation).

### 2.4 Locale (AR/EN)

`LanguageContext.tsx` + `layout.tsx`: locale is **cookie-based** (`force-language`, 1yr, `SameSite=Lax`), read server-side in `RootLayout` via `cookies()` so SSR chrome (titles, breadcrumbs, JSON-LD) matches the client. Switching language does a full `window.location.reload()` after writing the cookie. There is **no** `/en/`/`/ar/` URL segment or `Accept-Language` fallback today. This is a second, independent Dynamic-API dependency (separate from tenant resolution) that must be addressed for the same pages to be cacheable.

### 2.5 Dynamic-API census (confirmed via grep, not literal `force-dynamic` exports — there are none on storefront pages, only on `api/revalidate`, `api/store-favicon`, `og/route.tsx`)

Direct `headers()`/`cookies()`/`store-resolver` importers: `app/layout.tsx`, `app/page.tsx`, `app/products/page.tsx`, `app/products/[slug]/page.tsx`, `app/categories/page.tsx`, `app/about/page.tsx`, `app/contact/page.tsx`, `app/faq/page.tsx`, `app/how-to-guides/page.tsx`, `app/locations/page.tsx`, `app/blog/[slug]/page.tsx`, `app/not-found.tsx`, `app/manifest.ts`, `app/robots.ts`, `app/sitemap.ts`, `app/og/route.tsx`, `app/api/store-favicon/route.ts`.
Additionally, `app/page.tsx`, `app/products/page.tsx`, `app/categories/page.tsx`, `app/locations/page.tsx` read the `searchParams` prop directly (admin draft-preview token) — an **independent** dynamic-rendering trigger that survives even after `headers()`/`cookies()` are removed, and must be handled separately (see §3.6).
**Genuinely good news**: `cart`, `checkout`, `account/*`, `auth/*`, `wishlist`, `search`, `compare`, `review` page.tsx files call **none** of these directly — they're pure shells rendering `'use client'` components. Their dynamic behavior today is entirely inherited from the shared root layout, not from anything in the page itself. This means the "stays dynamic" routes need **zero page-level changes** — just an explicit `export const dynamic = 'force-dynamic'` once the shared layout stops forcing it for them implicitly (see §4).

### 2.6 R2 incremental cache — reality check (important, changes the Phase-0 gate)

Commit `0235b9dc` (this branch) hand-edits `apps/web/open-next.config.ts` + `wrangler.jsonc` to wire `r2-incremental-cache` against bucket `force-web-isr-cache`. **However**, `scripts/cf-setup-local.sh` — invoked unconditionally by `.github/workflows/cf-deploy.yml` on every `web` deploy (`bash scripts/cf-setup-local.sh web`) — **regenerates both files from scratch**, branching only on the `OPENNEXT_CACHE` repo variable:

- `OPENNEXT_CACHE` unset/false → emits the same **empty** config as before (`defineCloudflareConfig({})`) — the hand-edit in `0235b9dc` never survives a real deploy.
- `OPENNEXT_CACHE=true` → emits a **better** config than the hand-edit: R2 incremental cache **plus** `doShardedTagCache` (Durable-Object-backed, cross-isolate `revalidateTag`) **plus** a DO-backed queue — superseding `0235b9dc` entirely.

**Action required before any of this plan's Phase 1 lands**: confirm which state is live in the `ebda.app` production environment (check the `OPENNEXT_CACHE` GitHub Actions repo variable) and reconcile `0235b9dc` with the generator (either delete the hand-edit and set the repo variable, or fold the DO-sharded tag cache into the committed file and stop relying on the generator). Building full-page ISR on top of an incremental cache that isn't actually deployed, or whose `revalidateTag` only clears one isolate, would silently reintroduce the exact staleness bug this redesign is meant to fix — at page-cache scale instead of data-cache scale.

### 2.7 Existing invalidation plumbing

`apps/api/src/services/store.service.ts` → `revalidateStorefront({ slug, domain })` (`apps/api/src/lib/revalidate-storefront.ts`) → `POST /api/revalidate` (web) → `revalidateTag('store-domain:<domain>', 'max')` / `revalidateTag('store-slug:<slug>', 'max')`. This is the **only** caller today — product/category/blog edits get no explicit purge; they rely on the existing `next: { revalidate: 60 }` fetch-level staleness window, which is an already-accepted UX budget. Full-page ISR at the same 60s window is therefore **not a regression** for products/categories — it's consistency with what's already shipped. Theme/branding changes, which today get near-instant purge via the store tags, need the SAME tags threaded onto the full-page cache entry (see §5) or merchants will see their theme change purge the _data_ but still see stale full-page HTML for up to 60s — a visible, reportable regression if not handled.

## 3. Target architecture

### 3.1 Core invariant (non-negotiable)

Next's Full Route Cache / ISR keys cache entries by the **resolved pathname** (post-middleware-rewrite), not by `Host` header, cookies, or any custom header. Since one Worker serves every merchant domain, **tenant must become part of the matched pathname**, or two merchants' HTML collides in the same cache slot. This matches the standard multi-tenant Next.js pattern (middleware rewrite → `/[tenant]/...`, visible browser URL unchanged) — it is not a novel invention for this codebase, and the existing slug-stripping rewrite in `middleware.ts` (§2.1) is already 80% of this pattern for platform-domain traffic; it just needs to (a) also apply to custom domains, and (b) put the tenant key IN the path instead of only in a header.

### 3.2 Why the "lighter" alternatives don't work

- **Tag the response with a custom cache-control / Vary header instead**: Next's own ISR layer (and OpenNext's R2 cache) doesn't consult `Vary` for its internal cache key — this would need bypassing Next's cache entirely and reimplementing HTTP caching at the Cloudflare edge (Cache API/KV), a much bigger and riskier rewrite than the rewrite-based approach, and still wouldn't get ISR/ on-demand revalidation "for free" from Next.
- **Read `searchParams`/query string as the tenant key**: Next's default Full Route Cache key ignores the query string entirely unless the page reads `searchParams`, which itself forces full dynamic rendering — directly reintroducing the bug we're fixing.
- **Just remove `headers()`/`cookies()` from `store-resolver.ts` alone**: insufficient — `app/layout.tsx` independently calls both (§2.3); both must be fixed together or the layout alone keeps poisoning every route.

### 3.3 Two-track design (the scope-limiting decision)

Split storefront routes into exactly the two groups the user's brief already named, and treat them asymmetrically:

**Track A — cacheable** (anonymous, no personalization): home, `/products`, `/products/[slug]`, `/categories`, `/blog`, `/blog/[slug]`, `/about`, `/faq`, `/how-to-guides`, `/privacy`, `/terms`, `/returns`, `/shipping`, `/contact`, `/locations`.
Moved under a new segment tree, e.g.:

```
app/_store/[tenant]/[locale]/
  layout.tsx          <- NEW: store fetch by params (no headers()/cookies()), theme CSS, org JSON-LD
  page.tsx            <- moved from app/page.tsx
  products/page.tsx
  products/[slug]/page.tsx
  categories/page.tsx
  blog/page.tsx, blog/[slug]/page.tsx
  about/, faq/, how-to-guides/, privacy/, terms/, returns/, shipping/, contact/, locations/
```

`[tenant]` = normalized custom domain, or `slug:<slug>` for platform-path stores. `[locale]` = `en`|`ar`, resolved by **middleware** from the existing `force-language` cookie (falls back to store default when absent) — locale becomes a rewrite-target segment, NOT a URL the customer ever sees (see §6 for why this preserves SEO).

**Track B — stays dynamic** (personalized/session-bound): `/cart`, `/checkout` (+ `/checkout/success`, `/checkout/error`), `/account/*`, `/auth/*`, `/wishlist`, `/search`, `/compare`, `/review/[orderId]`.
**No file moves, no route restructuring.** Each gains (or keeps) `export const dynamic = 'force-dynamic'` explicitly (making the current implicit behavior explicit and immune to accidentally becoming static later — directly following the `feedback-migrate-before-deploy-and-force-dynamic` lesson's Trap 2 guidance). Middleware's existing header-only resolution is untouched for these paths.

Middleware decides which track a request belongs to using the SAME `KNOWN_APP_ROUTES`-style allowlist logic already in `middleware.ts` (extend it with a `CACHEABLE_ROUTES` set), so this is additive, not a rewrite of the existing routing logic.

**Admin live-preview stays on Track B's code path unconditionally**: middleware already computes `isPreviewIframe` (`?_preview=` present). Gate the new Track-A rewrite behind `!isPreviewIframe` — preview traffic (low volume, always authenticated-adjacent) keeps hitting the _existing_ flat, header-based, dynamic pages verbatim. This removes the hardest problem (draft-preview inside a cacheable layout) by construction: the cacheable layout never needs to know about drafts at all.

### 3.4 `generateStaticParams` / `dynamicParams` verdict

**Do not** add `generateStaticParams` to any Track-A dynamic segment (`[tenant]`, `[locale]`, `products/[slug]`). Leave `dynamicParams: true` (Next default) so every tenant/path combination renders on first request and is cached thereafter (on-demand ISR) — this is a direct, deliberate application of the `feedback-migrate-before-deploy-and-force-dynamic` memory: that incident's Trap 2 was exactly a header/cookie-dependent page that ALSO had a build-time-DB-querying `generateStaticParams`, coupling render mode to build-time DB reachability and causing a 3.5h outage when a migration lagged the deploy. With hundreds of independent, DB-driven tenants and a catalog that changes constantly, eager enumeration is also operationally wrong (build-time blowup, stale-until-rebuild for new stores/products) even ignoring that history.

### 3.5 PPR / `cacheComponents` verdict

Next `^16.2.6` is installed; `next.config.js` has neither `experimental.ppr` nor `experimental.cacheComponents` enabled today. PPR/dynamicIO could, in principle, let a single page stay static while carving a dynamic "hole" for the small genuinely-per-request bits (consent gate, locale-switch flash) without the Track A/B route-tree split above. It is **not** the Phase-1 vehicle:

1. It does not remove the core requirement in §3.1 — the tenant-in-cache-key problem is orthogonal to static/dynamic boundary within one route.
2. OpenNext-Cloudflare's PPR/dynamicIO maturity on the Workers runtime was not verified in this session (no upstream issue-tracker access) — do not bet the initial delivery on unverified framework-adapter behavior.
3. Recommend a **Phase 3 spike** (separate PR, CF-preview-only, feature-flagged) once Track A/B is live and stable, specifically to shrink the root-layout decomposition pain in §3.6 — not before.

### 3.6 Root-layout decomposition (the hardest piece)

`app/layout.tsx` must lose its unconditional `headers()`/`cookies()` calls, but Next requires exactly one root layout wrapping every route (both tracks). Decompose as:

- **`app/layout.tsx` (true root)**: html/body scaffold, fonts, global providers (Sentry/PostHog/OneSignal bootstrap that don't need per-request store data) — **zero** Dynamic API calls, zero per-store logic.
- **`app/_store/[tenant]/[locale]/layout.tsx` (new, Track A only)**: store fetch via `params` (new `getStoreByTenantParam()` in `store-resolver.ts`, sibling to `getStore()`, NOT replacing it), theme CSS injection, org JSON-LD, `generateMetadata`'s GSC-token custom-domain branch (reads `params.tenant` instead of `headers()`).
- **Track B pages** keep calling today's `getStore()`/`headers()`/`cookies()` exactly as-is, inside their own (possibly still-shared, still-flat) layout — unchanged, because they're intentionally dynamic.

Two concerns need an explicit decision, not a silent default, because they currently rely on unconditional SSR cookie reads inside the layout that Track A's new layout must NOT replicate unconditionally:

- **Consent-gating (marketing pixels)**: today SSR-omits `MarketingPixelsProvider` entirely when no consent cookie is present (explicit code comment: _"Client-side gating alone leaks the script on first paint; SSR gating prevents that"_). A cacheable Track-A layout cannot read the consent cookie per-request without re-forcing dynamic. **Requires sign-off** on one of: (a) default Track-A HTML to "no consent" (omit pixel script tags from the cached HTML) and let a client component synchronously check `document.cookie` before ever injecting the script tag into the DOM (returning consented visitors get pixels ~1 frame later than today, non-consented visitors are unaffected, first-paint leak guarantee preserved); or (b) defer consent-gated surfaces to the Phase-3 PPR spike (§3.5) so the gate becomes a true dynamic "hole" instead of an all-or-nothing per-route decision. Recommend (a) for Phase 1 — bounded, well-understood trade-off, ships now.
- **Locale flash on first paint for a first-time visitor with no cookie**: unaffected — resolution is identical to today (store default), just resolved in middleware instead of the layout.

## 4. Per-route disposition table

| Route                                                         | Track      | Render mode after migration                                                                           | Notes                                                                                              |
| ------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/` (home)                                                    | A          | ISR, `revalidate: 60`, tenant+locale in path                                                          | Draft-preview traffic bypasses via `!isPreviewIframe`                                              |
| `/products`                                                   | A          | ISR, `revalidate: 60`                                                                                 |                                                                                                    |
| `/products/[slug]`                                            | A          | ISR, `revalidate: 60`, `dynamicParams: true`, no `generateStaticParams`                               |                                                                                                    |
| `/categories`                                                 | A          | ISR, `revalidate: 60`                                                                                 |                                                                                                    |
| `/blog`, `/blog/[slug]`                                       | A          | ISR, `revalidate: 60`                                                                                 | `blog` list already client-shell only; only `[slug]` page needs the resolver swap                  |
| `/about`, `/faq`, `/how-to-guides`, `/contact`, `/locations`  | A          | ISR, `revalidate: 60`                                                                                 |                                                                                                    |
| `/privacy`, `/terms`, `/returns`, `/shipping`                 | A          | ISR, `revalidate: 60` (or fully static — no store-resolver call today, verify at implementation time) | Already client-shell only; may not need to move at all if they don't call `getStore()` server-side |
| `/cart`                                                       | B          | `force-dynamic` (explicit)                                                                            | No page-level change beyond the export                                                             |
| `/checkout`, `/checkout/success`, `/checkout/error`           | B          | `force-dynamic` (explicit)                                                                            |                                                                                                    |
| `/account/*`                                                  | B          | `force-dynamic` (explicit)                                                                            | Client-side auth per existing cross-origin-auth architecture rule                                  |
| `/auth/*`                                                     | B          | `force-dynamic` (explicit)                                                                            |                                                                                                    |
| `/wishlist`, `/search`, `/compare`                            | B          | `force-dynamic` (explicit)                                                                            |                                                                                                    |
| `/review/[orderId]`                                           | B          | `force-dynamic` (explicit)                                                                            | Order-specific, must stay per-request                                                              |
| `/og`, `/api/store-favicon`, `/api/revalidate`                | —          | unchanged (already `force-dynamic`)                                                                   | Out of scope                                                                                       |
| `/manifest.ts`, `/robots.ts`, `/sitemap.ts`, `/not-found.tsx` | —          | unchanged, stays dynamic                                                                              | Low QPS (bots/edge-cases), not perf-critical; optional future follow-up to move into Track A       |
| Admin page-builder preview (`?_preview=`)                     | B (forced) | unchanged, force-dynamic, header-based                                                                | Deliberately routed around Track A entirely                                                        |

## 5. Cache invalidation design

- **Reuse the existing tag scheme, extend it to the page cache**: `store-domain:<domain>` / `store-slug:<slug>` are already emitted by `store-resolver.ts`'s tagged fetches and already purged by `store.service.ts` → `revalidateStorefront()` → `POST /api/revalidate` → `revalidateTag(tag, 'max')`. Once Track A pages are statically cacheable and their own render is tagged with the same tags (Next's `fetch` tag propagation already covers this automatically since the layout's own store-fetch carries the tag), a merchant's theme/branding save purges the full-page cache too, for free — no new invalidation code needed for that surface.
- **New tag needed per-surface for products/categories** if merchants need faster-than-60s propagation on catalog edits (currently NOT wired — only `store.service.ts` calls `revalidateStorefront`): add `store:<storeId>:plp`, `store:<storeId>:pdp:<productId>`, `store:<storeId>:categories` tags to the respective page fetches, and call sites in `apps/api/src/services/product.service.ts` / `category.service.ts` (mirroring `store.service.ts`'s existing call). Treat as an **optional enhancement**, not required for parity — the 60s window is already the accepted UX for these surfaces today.
- **Prerequisite (blocking)**: the DO-sharded tag cache (§2.6) must be confirmed live, or `revalidateTag` only clears the isolate that served the purge request — a merchant could see their save reflected on one Cloudflare PoP and not others for an indefinite window. This is worse at full-page-cache scale than at data-cache scale (bigger visible blast radius per stale isolate).

## 6. SEO / hreflang / canonical implications

- **No existing hreflang/canonical infrastructure today** (confirmed — no `alternates`/`canonical` in any `generateMetadata`). The redesign does not need to retrofit one, but must not accidentally break the CURRENT (already-imperfect) SEO state.
- **Critical design choice**: locale is carried as an _internal rewrite target only_ (`/_store/<tenant>/en/...` vs `/_store/<tenant>/ar/...`), never as a visible URL segment. The customer-facing, Google-indexed URL (`demo-merchant.com/products/x`) is **unchanged** — this avoids any 301/redirect/re-indexing risk entirely. Googlebot sends no `force-language` cookie, so it will always see whichever locale middleware treats as default — identical to today's behavior (no regression).
- **Explicitly out of scope, flagged as a separate future project**: true bilingual SEO (indexable `/ar/` URLs with proper `hreflang` alternates) would require a real URL-visible locale segment plus redirects plus a sitemap-per-locale — a bigger, independent SEO initiative. This plan neither blocks nor requires it.

## 7. AR/EN locale as a cache dimension

- Middleware reads the `force-language` cookie (already exists, already 1yr/`SameSite=Lax`) and resolves it to `en`|`ar` (falling back to the store's `defaultLanguage` setting when absent) BEFORE the rewrite, then bakes it into the internal path segment. This is the only way to let Next cache the English and Arabic renders of the same visible URL as two distinct entries instead of forcing dynamic rendering to read the cookie at render time.
- Client-side language switch (`LanguageContext.setLanguage`) already does a full `window.location.reload()` after writing the cookie — unchanged; the reload re-enters middleware with the new cookie value, hits the other locale's cache entry (or generates it on first request).
- `rtl`/`ltr` `dir` attribute and font-family switching in `LanguageProvider` remain entirely client-side — unaffected.

## 8. Risk register

| #   | Risk                                                                                                                                    | Severity                               | Mitigation                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cross-tenant HTML cache collision if any Track-A code path still reads `headers()`/`cookies()` for tenant/theme (a missed call site)    | Critical                               | Grep-verified zero `headers()`/`cookies()` imports under `app/_store/**` as a CI check; mandatory two-domain-mode E2E cache test (§9) before every promotion                                                                                                   |
| 2   | `OPENNEXT_CACHE` repo variable / DO-sharded tag cache not actually live in prod (§2.6)                                                  | High                                   | Phase-0 gate: verify in CF dashboard/GitHub Actions vars before Phase 1 ships; reconcile `0235b9dc` with `cf-setup-local.sh`                                                                                                                                   |
| 3   | Consent-gating behavior change (client-check-before-mount) shipped without legal/Ahmad sign-off                                         | High                                   | Explicit go/no-go decision point in Phase 2, not silently shipped                                                                                                                                                                                              |
| 4   | `generateStaticParams` added later by someone unaware of the history, re-coupling render mode to build-time DB reachability             | High (recurrence)                      | Lint/CLAUDE.md note + code comment referencing `feedback-migrate-before-deploy-and-force-dynamic`; no `generateStaticParams` anywhere under `_store/`                                                                                                          |
| 5   | Client-store pixel-diff — wady-aljuz / demo-store render differently post-migration                                                     | Critical (explicit client requirement) | Visual regression diff (Playwright screenshot compare) both stores, both locales, before/after, as a release gate                                                                                                                                              |
| 6   | `useStoreUrl()` (75-edge god node) href-building logic diverges between Track A (new tenant/locale-aware paths) and Track B (unchanged) | Medium                                 | Single audit pass over all `useStoreUrl()` call sites before Phase 1 merge; the visible URL contract doesn't change, so most callers need zero edits — verify, don't assume                                                                                    |
| 7   | Draft-preview iframe accidentally hits the new cacheable tree (stale/mixed-tenant preview)                                              | High                                   | `!isPreviewIframe` gate in middleware is the single point of control — add an explicit E2E test that a `?_preview=` request never receives a `cf-cache-status: HIT`-style header                                                                               |
| 8   | Migration attempted as one big-bang PR                                                                                                  | High (process)                         | Explicitly sequenced, gated phases (§9) — no single PR moves both the route tree AND flips production traffic                                                                                                                                                  |
| 9   | Rollback needed mid-migration                                                                                                           | Low (well-covered)                     | Workers deploys are atomic; `scripts/rollback.sh` (`git revert && push`) or `wrangler rollback` instantly reverts a single bad deploy; middleware rewrite can also be feature-flagged (env var) to fall back to today's header-only path without a code revert |

## 9. Migration steps — zero-downtime, gated

**Phase 0 — Prerequisite verification (no code change)**

- Confirm `OPENNEXT_CACHE` repo variable state and whether the DO-sharded tag cache is actually deployed; reconcile `open-next.config.ts`/`wrangler.jsonc` (§2.6, §5 prerequisite).
- **Gate**: R2 cache hit confirmed on a CF preview deploy for an existing tagged `fetch()` (e.g. product-detail fetch) via response inspection / Cloudflare cache analytics, before any route-tree work starts.

**Phase 1 — Middleware rewrite + new segment tree, dark-launched**

- Add `CACHEABLE_ROUTES` classification + tenant/locale-encoding rewrite to `middleware.ts`, gated behind an env var (`STOREFRONT_TENANT_ROUTING=false` default) so it's inert until flipped.
- Move Track-A pages under `app/_store/[tenant]/[locale]/`, add the new nested layout, add `getStoreByTenantParam()` sibling function in `store-resolver.ts` (do not touch `getStore()`).
- Track-B pages get explicit `export const dynamic = 'force-dynamic'`.
- **Gate**: build succeeds; `npm run typecheck`; local `next build && next start` smoke-test both a custom-domain-shaped and platform-slug-shaped request; zero behavior change with the flag off (byte-diff HTML against `main`).

**Phase 2 — CF preview verification (flag on, preview only)**

- Enable `STOREFRONT_TENANT_ROUTING=true` on a CF preview Worker only.
- **Gate**: two-domain-mode E2E (§10) green on preview; visual diff clean for wady-aljuz + demo-store in both locales; confirm cache-hit headers differ correctly per tenant+locale for the SAME pathname across two different Host headers hitting the SAME preview Worker (the critical cross-tenant-collision test).

**Phase 2 status (2026-09-25, `feat/tenant-routing-canary`)** — run on an isolated Worker (`force-web-canary-preview`, workers.dev only, own R2 bucket + DOs, flag on for `about,faq,home`):

- Cross-tenant: 40 interleaved responses (demo-store / demo-merchant / demo-boutique on the same pathnames, both locales) — each carried only its own store, 0 foreign-store hits. `?_preview=` and non-listed routes never entered the tenant tree.
- Visual: 24 full-page screenshots (both stores × about/faq/home × en/ar × desktop/mobile), preview vs production — 0 differing pixels in all 24 (positive control: en vs ar = 82,202 px).
- Found and fixed before any canary: the nested layout re-emitted the store chrome the root layout already renders — a second `MarketingPixelsProvider` (every PageView fired twice for consenting visitors), a duplicate Organization JSON-LD, and a divergent typography `<style>` (`emitZoneCss` ≠ the root emitter). Gated behind `ROOT_LAYOUT_OWNS_STORE_CHROME`.
- NOT provable yet — cache hits: every tenant-tree route still builds as `ƒ` and answers `cache-control: private, no-store`, because the root `app/layout.tsx` still calls `headers()`/`cookies()`. The canary moves traffic onto the new tree with no perf change; the cache-key tests (§10 second bullet) become meaningful only after the root-layout decomposition (§3.6).
- Blocker for full-page caching (not for the canary): with no `force-language` cookie the middleware keys the request as `en`, but the root layout renders the store's `defaultLanguage` (both live stores default to `ar`). Once pages cache, a cookie-less visitor and an `en`-cookie visitor would share one `/en/` entry with different content. The middleware now learns the store default from the store token (`STOREFRONT_TENANT_ROUTING_STORES=demo-boutique:ar`, Ruling TRC-7), so a cookie-less visitor to an Arabic-default store is keyed `ar`; the declared default must equal the store's `settings.defaultLanguage` (the runbook's cookie-less check catches a drift). Until the root-layout decomposition the tenant layout emits no metadata of its own and the product page resolves locale cookie-then-store-default like the root (issue 2407, Ruling TRC-5), so the canary's titles and `og:locale` match flag-off.

**Phase 0 re-check (2026-10-29, Ruling TRC-8):** gate NOT passed, flag stays off. Root layout still reads `headers()`/`cookies()`; all 15 tenant-tree routes build dynamic; prod serves `no-store`. Unblock = root-layout decomposition (3.6), then Phase 2 on a CF preview.

**S2-REVIVE (2026-11-09, Ruling STORE-EDGE-2):** launch caching comes from the Worker-level store HTML edge cache (`apps/web/store-edge-cache.ts`, ON for every active store, off in one step with the secret `STOREFRONT_HTML_EDGE_OFF=1`), not from this plan. This plan's flag stays off until 3.6 lands.

**Phase 3 — Consent-gating decision + production canary**

- Ship the consent-gating adaptation (§3.6) with explicit sign-off.
- Flip `STOREFRONT_TENANT_ROUTING=true` in production for one low-traffic surface first (e.g. `/about`, `/faq` — no revenue impact if wrong) before PLP/PDP/home.
- The main flag needs `STOREFRONT_TENANT_ROUTING_ROUTES` beside it (e.g. `about,faq`) AND `STOREFRONT_TENANT_ROUTING_STORES` (e.g. `demo-boutique:ar`); with either list missing the flag routes nothing. **All three are Worker-wide secrets on `force-web-cf-preview`, which serves every live store (demo-boutique, demo-store, demo-merchant at once), so a route list alone widens to all of them: the canary is scoped to ONE store only by the store allowlist (Rulings TRC-5, TRC-6, TRC-7).** Follow `docs/runbooks/tenant-routing-canary.md`; its Verify includes a request with NO `force-language` cookie. Pixels and the Organization JSON-LD render exactly once with the flag on or off (#709): the tenant-store layout defers the store chrome to the root layout while `ROOT_LAYOUT_OWNS_STORE_CHROME` is true, guarded by `tests/unit/web-tenant-tree-store-chrome-render.test.tsx`.
- **Gate**: 24-48h observation window, error-rate/Sentry check, no cross-tenant report, before widening to PLP/PDP/home.

**Phase 4 — Full production rollout**

- Widen the flag to all Track-A routes: set `STOREFRONT_TENANT_ROUTING_ROUTES=all`. The list is fail-closed (#1980): a missing, empty or unparseable value routes nothing, so every widening step is an explicit value change and deleting the variable turns the rewrite off.
- **Gate**: cache-hit ratio dashboard shows non-zero HITs on Track-A routes (proof the fix worked, not just "no errors"); revalidateTag round-trip test (merchant saves theme → full page reflects within the same budget as today's data-cache purge).

**Phase 5 (optional, later) — PPR/`cacheComponents` spike**

- Separate PR, CF-preview only, evaluates whether it can shrink the root-layout split further. Not a blocker for Phases 1-4.

Every phase is reversible independently: the env-var gate means any phase can be rolled back by flipping it off (no redeploy needed if the var is read at request time, or a single fast Worker redeploy if compiled in) without touching the phases before it.

## 10. Test plan

- **Unit**: `store-resolver.ts` — new `getStoreByTenantParam()` behaves identically to `getStore()` for the same store, given equivalent inputs (params vs headers).
- **Integration**: `POST /api/revalidate` round-trip — save a store theme via the API, assert the tag is purged AND (post-migration) the full-page cache entry for that store's home page is regenerated on next request, not served stale.
- **E2E (Playwright), two domain modes** — run every existing storefront E2E spec (`tests/e2e/store.test.ts`, `tests/smoke/storefront.smoke.spec.ts`) twice: once simulating a custom-domain `Host` header (wady-aljuz-shaped), once simulating platform-slug path — both against the SAME preview Worker in the same run, asserting:
  - Correct store content renders (no cross-contamination) when interleaving requests for two different tenants against the same pathname.
  - A cache-hit indicator (custom response header, or Cloudflare cache-status) appears on the second request for the same tenant+path+locale, and does NOT appear (or differs) when only the tenant or only the locale changes.
  - `?_preview=` requests never show a cache-hit indicator (Track B / preview-bypass verification).
- **Visual regression**: Playwright screenshot diff for wady-aljuz + demo-store, home/PLP/PDP, both `en`/`ar`, before vs after each phase — zero pixel diff required (client-store parity requirement).
- **Load/perf**: before/after p95 TTFB comparison on PLP/PDP under k6, confirming the actual perf win materializes (cache HIT path should be dramatically faster than the current always-dynamic path) — this is the entire point of the redesign, so it needs a measured before/after, not just "no errors."

## 11. Rollback plan

1. **Fastest**: flip the `STOREFRONT_TENANT_ROUTING` env var off (no redeploy if read at request time) — falls back to today's header-only resolution, verbatim, for every route.
2. **Standard**: `bash scripts/rollback.sh` (`git revert HEAD --no-edit && git push`) — `cf-deploy.yml` redeploys the reverted Worker atomically.
3. **Instant**: `wrangler rollback` on `force-web-cf-preview` to the immediately-prior Worker version (per `docs/ROLLBACK.md` "A. Per-worker fast-path") — no git operation needed, sub-second.
4. No database migrations are involved in this change (route/cache-layer only), so there is no Neon PITR / schema-rollback dimension to coordinate — rollback is code-only and Worker-only, matching Ahmad's "never promote one app alone" rule trivially since only `apps/web` (and a small, backward-compatible `apps/api` tag addition in Phase-1-optional) are touched.

---

### Critical Files for Implementation

- ~/Desktop/projects/ebda-store/apps/web/middleware.ts
- ~/Desktop/projects/ebda-store/apps/web/src/lib/store-resolver.ts
- ~/Desktop/projects/ebda-store/apps/web/src/app/layout.tsx
- ~/Desktop/projects/ebda-store/apps/web/open-next.config.ts
- ~/Desktop/projects/ebda-store/scripts/cf-setup-local.sh
