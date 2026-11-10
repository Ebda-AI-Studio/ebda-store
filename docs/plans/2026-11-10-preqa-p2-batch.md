# Pre-QA sweep, P2 batch: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native, one session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the small findings of the 2026-11-09 production sweep (rows 4, 5, 7 to 13) and make the manifest an `/en` storefront page links to resolve in English.

**Architecture:** One branch (`fix/preqa-p2-batch`), one task per finding. Each task is verified against production or source before it is changed, fixes the whole class at its source, and carries a test that can fail. A finding that is not changed gets a ruling under `docs/rulings/`.

**Tech stack:** Next 16.4.3 (storefront on OpenNext/Workers, marketing as a static export), vitest 4 (`tests/unit/`, colocated `*.test.ts(x)` in `apps/web`), Tailwind, plain CSS in `apps/marketing`.

**Spec:** the controller brief of 2026-11-10 and the sweep table `~/.claude/handoff/7a9522b0-eb96-4ac7-be4e-c391da69fabf-preqa.md` (rows 4, 5, 7 to 13).

## Global constraints

- Master brand is "Ebda AI Studio" («ابدأ ستوديو للذكاء الاصطناعي»); products are "Ebda <X>"; never a bare "Ebda" / «ابدأ» as a brand.
- Ebda's own surfaces use no orange: night grounds with Ebda gold `#B08D57`. Merchant-chosen colours are never touched or validated.
- Legal pages are formal Arabic throughout; marketing sentences are Egyptian.
- Arabic first and RTL: every UI change is checked on `/ar` and `/en` at 360 px and 390 px, by computed style or DOM, not by screenshot.
- No API auth behaviour change. Off limits: `apps/api/src/middleware/*` limiters and tenant-context, `apps/api/src/routes/public.routes.ts`, `apps/api/src/routes/pages.routes.ts`.
- Controller-owned lines (do not touch): `apps/marketing/src/components/RootShell.tsx`, the `<html>` line of `apps/web/src/app/layout.tsx` and `apps/admin/src/app/layout.tsx`, the header buttons in `apps/marketing/src/components/Header.tsx`, header rules in `chrome.css` / `globals.css`, `tests/unit/marketing-nav.test.tsx`.
- The Arabic manifest of `storedemo.ebda.app/manifest.webmanifest` stays byte-identical to the post-#505 baseline.
- Production is read with GET requests only.

## Review focus

1. A new marketing page added later without JSON-LD: the route walk must fail on it (Task 1 test walks the directory, not a list).
2. A visitor with a real session but no `hadSession` hint (Safari ITP) on a second intent route: the once-per-tab probe must still have run once (Task 3 test).
3. Consent bar dismissed while the menu is open: the menu must grow back (Task 4 test removes the bar and reads the property).
4. A store with locale paths OFF: its manifest link stays `/manifest.webmanifest` (Task 10 test).
5. `/ar//evil.com/manifest.webmanifest`-style paths: only the exact `/ar|en/manifest.webmanifest` is rewritten (Task 10 test).

---

### Task 1 (#4): JSON-LD on every marketing page

Measured 2026-11-10: 26 of 64 `ebda.app` URLs emit no `application/ld+json` (legal, legal extras, contact, credits, services index).

**Files:** modify `apps/marketing/src/lib/seo.ts`, `components/LegalPage.tsx`, `ContactPage.tsx`, `CreditsPage.tsx`, `ServicesIndexPage.tsx`; create `tests/unit/marketing-jsonld-route-walk.test.tsx`.

**Interface:** `pageJsonLd(locale: Locale, page: PageSlug, name: string, description: string, type?: 'WebPage' | 'ContactPage' | 'CollectionPage'): object` in `seo.ts`: one node with `@id` `<url>#webpage`, `url`, `name`, `description`, `inLanguage`, `isPartOf` `{ '@id': '<site>/#website' }`, `publisher` `{ '@id': '<site>/#organization' }`.

- [ ] Test first: walk every `page.tsx` under `apps/marketing/src/app`, render its default export with `EBDA_SERVICE_LINES=on`, and fail on any page whose markup has no `<script type="application/ld+json">` that parses and carries `@context`. Expect it to fail on the 26 routes.
- [ ] Add `pageJsonLd` and render `<JsonLd>` in the four components.
- [ ] Verify: the walk passes; `marketing-seo`, `marketing-legal-extra`, `marketing-site`, `marketing-service-lines` stay green.

### Task 2 (#5): bare brand name in legal copy

Reproduced in source: `apps/marketing/src/lib/legal-ar.ts:309` «منتجات ابدأ».

**Files:** modify `apps/marketing/src/lib/legal-ar.ts` (+ any sibling hit); extend `tests/unit/marketing-chat-name.test.ts` or create `tests/unit/marketing-legal-bare-brand.test.ts`.

- [ ] Test first: over every string of `legal-ar.ts`, `legal-en.ts`, `legal-deletion.ts`, `legal-privacy-stack.ts`, `legal-refund.ts`, `legal-wa-ar.ts`, `legal-wa-en.ts`, fail on «ابدأ» not followed by «ستوديو|ستور|شات» and on `Ebda` not followed by ` AI Studio| Store| Chat| Studio` (allow hostnames and e-mail addresses).
- [ ] Fix each hit with the formal master-brand name. Vendored `legal-wa-*` hits are fixed at their source script or ruled.
- [ ] Verify: the test passes; `marketing-legal-ar-formal`, `marketing-wa-legal-drift` stay green.

### Task 3 (#7): guest 401 noise from `/auth/me` and `/auth/refresh`

Evidence: returns = 2x `/auth/me` 401 + 1x refresh 401; cart = 1 + 1; checkout = 1.

**Files:** modify `apps/web/src/app/returns/ReturnsClient.tsx:80-85`, `apps/web/src/app/wishlist/WishlistClient.tsx:93`, `apps/web/src/lib/api.ts`, `apps/web/src/contexts/AuthContext.tsx`; tests colocated.

**Interface:** `sessionProbeSpent(): boolean` exported from `api.ts` (reads sessionStorage `authProbe`, false when storage throws).

- [ ] Test first: (a) ReturnsClient makes no `/auth/me` request without a session hint; (b) AuthContext on an intent route with no hint and a spent probe makes no request and ends `isLoading=false`; (c) with no hint and an unspent probe it still calls once.
- [ ] Gate the two blind callers with `hasSessionHint()` (the `ReviewSection.tsx:191` pattern); AuthContext skips when `!hasSessionHint() && sessionProbeSpent()`.
- [ ] Ruling AUTH-PROBE-2: the single once-per-tab pair on the first intent route stays (Safari ITP healing, #2164); removing it needs a server-set readable hint, which is an API auth change.

### Task 4 (#8): last mobile-menu item under the consent bar

Evidence: `ebda.app/` at 390x844, last item rect 769 to 813, hit test lands on `#ebda-consent`.

**Files:** modify `packages/shared/src/tracking/browser.ts` (`showBanner`), `apps/marketing/src/app/globals.css` (one line, the `max-height` of `.nav-menu > ul` at max-width 520px); test in `tests/unit/`.

- [ ] Test first: `showBanner()` sets `--ebda-consent-h` on `documentElement` to the bar's occupied height (height + bottom offset) and removes it when the bar is dismissed.
- [ ] CSS: `max-height: calc(100dvh - 88px - var(--ebda-consent-h, 0px))`.
- [ ] Verify on a local static build at 360 and 390, `/` and `/en/`: with the bar shown, the last menu item's `elementFromPoint` is the item itself after scrolling the panel.

### Task 5 (#9): amber in the Lookbook look preview

Reproduced in source: `apps/marketing/public/looks/qamar.html` carries `#e8a33d` in chrome CSS while `scripts/looks/qamar.py` already uses moon silver `#D9DCEB` (ruling B1-102).

**Files:** regenerate `apps/marketing/public/looks/*.html` with `npm run looks -w apps/marketing`; extend `tests/unit/qamar-looks-contrast.test.ts`.

- [ ] Test first: no published look HTML has `e8a33d` outside a `data-p-colors` product swatch attribute.
- [ ] Regenerate; the diff must be limited to the look files; grep `e8a33d|232, ?163, ?61` across Ebda defaults and marketing.
- [ ] Ruling for the demo product swatch «زعفراني» (product data, not chrome).

### Task 6 (#10): 14 px selects on storefront checkout

Reproduced in source: `apps/web/src/components/demo/DemoLookBar.tsx:24` (`DEMO_BAR_SELECT_CLASS`).

**Files:** modify `DemoLookBar.tsx` and any sibling found by the sweep; extend `DemoLookBar.test.tsx`; create `tests/unit/storefront-form-control-font-size.test.ts`.

- [ ] Test first: every `<select>`, `<input>` (text-like) and `<textarea>` class string in `apps/web/src` that sets a text size resolves to 16 px or more below the `sm` breakpoint (`text-base` base, smaller only behind `sm:`/`md:`), with an explicit allowlist for non-text inputs.
- [ ] Fix each hit to `text-base sm:text-sm` (or the control's own equivalent).

### Task 7 (#11): one register on the storefront returns page

Reproduced in source: `ReturnsClient.tsx:535` and `LanguageContext.tsx:205` «المرتجعات واسترداد الفلوس» over a formal body.

- [ ] Test first: no Egyptian marker («الفلوس», «عايز», «دلوقتي», «إزاي», «مش», «ليه», «هنـ») in the Arabic strings of `ReturnsClient.tsx` and the returns keys of `LanguageContext.tsx`.
- [ ] Heading becomes «المرتجعات واسترداد الأموال» in both places.

### Task 8 (#12): RSC prefetches on the demo home

- [ ] Measure with full URLs (GET only, 390x844, `storedemo.ebda.app/en`): which links issue the 11 `/en/products` and 2 `/cart` prefetches.
- [ ] If they are footer or below-the-fold links through `StoreLink`, set `prefetch={false}` there and pin it with a test; otherwise write Ruling with the measured list.

### Task 9 (#13): 307 on trailing-slash redirects

Measured: `ebda.app/{legal,privacy,en,services}` answer 307 from Workers static assets (`html_handling: "auto-trailing-slash"`, no status option).

- [ ] Ruling MKT-REDIRECT-307: unchanged before launch. A 308/301 needs a `_redirects` rule in front of the platform normalisation (loop risk) and is cached permanently by browsers; the site has no POST handlers, so 307 costs nothing but a re-validated hop.

### Task 10 (extra): the manifest an `/en` page links to is English

Root cause (measured): `/en` links `/manifest.webmanifest`; `/en/manifest.webmanifest` answers 301 to it; browsers fetch a manifest without cookies, so the resolver falls to the store default. Next 16.4.3 lets a root `app/manifest.ts` override `metadata.manifest`, so the link cannot be per-language while the file convention is used (measured in a scratch build: with `app/manifest.webmanifest/route.ts` the link follows `metadata.manifest`).

**Files:** move `apps/web/src/app/manifest.ts` to `apps/web/src/lib/pwa/store-manifest.ts` (named export `buildStoreManifest`, body unchanged) with its test; create `apps/web/src/app/manifest.webmanifest/route.ts`; modify `apps/web/src/lib/locale-paths.ts`, `apps/web/middleware.ts`, `apps/web/src/lib/storefront-metadata.ts`, `apps/web/src/app/layout.tsx` (`generateMetadata` only), `apps/web/src/app/tenant-store/[tenant]/[locale]/layout.tsx`; ruling PWA-MANIFEST-2.

**Interfaces:**

- `decideLocalePath` gains `{ kind: 'manifest'; locale: PathLocale }` for exactly `/ar/manifest.webmanifest` and `/en/manifest.webmanifest`; the middleware rewrites it to `/manifest.webmanifest` with `x-locale-path`, no language cookie.
- `manifestHref(urlLocale: 'ar' | 'en' | null): string` in `locale-paths.ts`: `/<locale>/manifest.webmanifest` or `/manifest.webmanifest`.
- `GET` in the route answers `JSON.stringify(await buildStoreManifest())` with `Content-Type: application/manifest+json` and `Cache-Control: public, max-age=0, must-revalidate` (what Next's own manifest route sent).

- [ ] Tests first: `decideLocalePath` cases (exact path only, GET/HEAD only, `/ar//x/manifest.webmanifest` not rewritten); the route under `x-locale-path: en` returns the English name on an Arabic-default store and under no header returns the Arabic one; metadata `manifest` is `/en/manifest.webmanifest` on a prefixed page and `/manifest.webmanifest` otherwise; the moved manifest suite stays green unchanged.
- [ ] Verify: for the storedemo-shaped fixture the unprefixed body is produced by the same builder with the same serialiser; after deploy, `cmp` against `manifest-post-505-ar.json` (not verifiable before deploy).
