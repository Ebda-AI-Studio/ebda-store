# UI/UX Audit — Force Website Builder

**Date:** 2026-04-25
**Scope:** `apps/admin/src` (admin dashboard) + `apps/web/src` (5-template storefront)
**Methodology:** Four parallel read-only auditor subagents (admin UI, web UI, perf, code-quality) cross-referenced against Vercel Labs Web Interface Guidelines and `ui-ux-pro-max` UX rules.

---

## Headline

The codebase is in unusually good shape after this week's refactor push. **Zero `any`, zero `console.log`, zero `TODO`/`FIXME`**, every user-facing string wrapped in `t()`, every status message carrying `role="alert"` / `aria-live`, build green across 49 admin routes + 30 web routes, admin bilingual end-to-end.

What's left is **product-grade polish**, not scaffolding:

- A ~200-line mechanical sweep (missing `type="button"`, icon-button `aria-label`, logical RTL classes that slipped through)
- One architectural Simplification (collapse 5 status-badge variants into 1)
- Five high-ROI perf fixes (LCP on storefront homepage is currently client-rendered)
- Minor design-token cleanup (decorative palette colors vs. semantic tokens)

Everything below is ranked by severity × effort. The first 3 sections are the **P0/P1 fix list**. Later sections are context.

---

## P0 — Critical (ship blockers if user-visible)

### 1. Storefront homepage renders LCP after JS + chunk + API (`apps/web/src/app/page.tsx`)

**Perf, severity: critical.** The homepage is `'use client'` and blocks Hero rendering behind dynamic-imported template + `api.getProducts()` resolution. LCP waits for JS parse → chunk fetch → API round-trip. Production Lighthouse LCP will be poor.

**Fix:** convert to server component. Resolve template at page level via direct import (the existing `getTemplateComponents` map is sync-compatible). Fetch products server-side like `/products/page.tsx` already does. Pass `initialData` into a thin client wrapper. Affects: `apps/web/src/app/page.tsx`, `apps/web/src/hooks/useTemplateComponents.ts`.

### 2. All 5 hero `<Image fill priority>` missing `sizes`

**Perf, severity: critical.** `apps/web/src/templates/{modern,classic,elegant,bold,minimal}/Hero.tsx` each render the LCP image with `fill` + `priority` but no `sizes`. Browser downloads the largest srcset variant on every breakpoint (200–700 KB waste). Next.js 16 logs a runtime warning.

**Fix:** `sizes="100vw"` (or `(min-width:1024px) 60vw, 100vw` for elegant's 60/40 split). One-line change per file.

### 3. `<div onClick>` as primary interaction on marketing-pixels card

**A11y, severity: critical.** `apps/admin/src/app/stores/[id]/marketing-pixels/_components/PixelPlatformCard.tsx:48` wraps the entire card header in a `<div onClick={onExpand}>`. Not focusable, no keyboard handler, no `role`, no `aria-expanded`. WCAG 2.1.1 violation.

**Fix:** `<button type="button" aria-expanded={expanded}>`.

### 4. Native `confirm()` for destructive order actions

**UX/a11y, severity: critical on RTL.** `apps/admin/src/app/stores/[id]/orders/page.tsx:104,127` use `window.confirm(...)` for mark-paid + bulk-mark-paid. Native dialogs don't honor RTL, don't honor theme, don't run through i18n, block main thread. Similarly `prompt()` in `useReturns.ts:114,161` for reject reason + refund method.

**Fix:** existing modal pattern (e.g. `CouponFormModal`, `TaxRateFormModal`). Reuse.

### 5. Form inputs with no associated label

**A11y, severity: critical.** Screen reader users cannot identify the field's purpose.

- `apps/web/src/app/products/ProductsFilterSidebar.tsx:36-59` — filter search input
- `apps/admin/src/app/stores/[id]/branding/_components/ContactInfoTab.tsx:21,31,44,54,68,78` + `BrandingIdentityTab.tsx:22,31,48,59` — multiple raw inputs with `<label>` siblings missing `htmlFor`/matching `id`

**Fix:** add `htmlFor={id}` + matching `id`. For admin, better: route through `@ebda/ui` `<Input label={...}>` which handles this automatically.

---

## P1 — High (user-visible, cheap to fix)

### 6. Missing `type="button"` on buttons inside forms

**Interaction, severity: high.** A button without explicit `type` inside a `<form>` defaults to `type="submit"` and can fire the form's submit handler unintentionally.

**Admin hits** (representative, not exhaustive): `branding/page.tsx:80`, `template/page.tsx:171,189`, `features/page.tsx:148,179,186`, `categories/CategoryTable.tsx:169,175`, `coupons/_components/CouponsTable.tsx:197,236,255`, `audit-logs/page.tsx:248`, `customers/page.tsx:163,212`, `orders/page.tsx:184,203`, `payment-settings/page.tsx:215,224`, `announcement/page.tsx:104`, `pages/page.tsx:260`, `seo/page.tsx:134`, `categories/page.tsx:194,211`, `users/[id]/page.tsx:151`.

**Web hits** (representative): `compare/CompareClient.tsx:158`, `products/ProductsClient.tsx:309,332,389,486`, `products/ProductsFilterSidebar.tsx:69,91,116`, `products/[slug]/ProductDetailClient.tsx:339,407,414`, `auth/forgot-password/ForgotPasswordClient.tsx:78`, `faq/FAQClient.tsx:113`, `checkout/PaymentStep.tsx:73,95,186`, `checkout/CheckoutClient.tsx:582`.

**Fix:** blanket regex sweep. A single subagent can do this in minutes.

### 7. Icon-only buttons missing `aria-label`

**A11y, severity: high.** Screen readers announce "button" with no purpose.

**Hits:** `variants/_components/VariantsTable.tsx:97,116`, `OptionsPanel.tsx:56,77`, `coupons/_components/CouponsTable.tsx:197,236,255`, `ProductDetailClient.tsx:407,412` (quantity steppers on web PDP).

**Fix:** add `aria-label={t(...)}` to each. Same pass as #6.

### 8. Tap targets below 44×44 across storefront headers

**A11y/touch, severity: high.** Inconsistent across 5 templates:

- **Modern** Header: `p-2` + `w-5 h-5` ≈ 36×36
- **Bold** Header: `p-2` + `w-5 h-5` ≈ 36×36
- **Classic** Header: `p-2` ≈ 36×36
- **Elegant** Header: **no padding** + `w-5/6` ≈ 20×20
- **Minimal** Header: **no padding** + `w-4 h-4` ≈ 16×16 ← worst

Same issue in the shared `templates/shared/card-actions.tsx:36` (`h-9 w-9` = 36×36) → blast-radius: every ProductCard wishlist button in 5 templates.

**Fix:** bump `card-actions.tsx` buttons to `h-11 w-11`; add `p-2.5` to all 5 Header icon buttons.

### 9. RTL: remaining directional classes in storefront + toggle pseudo-elements

**RTL correctness, severity: high.** Despite the sweep, a few remain:

- `templates/shared/card-actions.tsx:27,92` — `left-3`/`right-3` ternary (should be `start-3`/`end-3`)
- `apps/admin/src/app/stores/[id]/announcement/page.tsx:154` + `pages/page.tsx:303` — `after:left-[2px]` toggle thumb (should be `after:start-[2px]`)
- `apps/admin/src/app/stores/[id]/template/page.tsx:242` — `top-4 right-4` selected-checkmark (should be `end-4`)
- `apps/admin/src/components/AdminLayout.tsx:178` — mobile sidebar `translate-x-0`/`-translate-x-full` slides off the wrong side in Arabic
- `apps/admin/src/components/Toggle.tsx:29`, `ToggleSwitch.tsx:23`, `AffiliateCommissionForm.tsx:109,132` — toggle thumb `translate-x-5/6` with no `rtl:` mirror → thumb slides wrong way in Arabic

**Fix:** pair each with `rtl:-translate-x-*` or use logical equivalents. Pattern example in `payment-settings/_components/ProviderCard.tsx:93`.

### 10. Raw `<img>` instead of `<Image>` in 10+ admin files

**Perf/CLS, severity: high.** Missing width/height = CLS hit; missing optimization = larger images served. Plus 1 web instance.

- Admin: `ProductSearch.tsx:110`, `SelectedProductCard.tsx:18`, `ProductsTable.tsx:117`, `categories/CategoryTable.tsx:122`, `pwa/_components/PwaIconUploader.tsx:36,57,78`, `returns/_components/ReturnDetailsDrawer.tsx:111`, `analytics/_components/TopProductsTable.tsx:28`, `analytics/_components/LowStockAlertsCard.tsx:43`, `products/[productId]/_components/ProductInfoSections.tsx:156`
- Web: `templates/modern/Header.tsx:63` — only Modern's logo uses raw `<img>`; other 4 templates use `<Image>`

**Fix:** convert each to `next/image` with explicit `width`/`height`.

### 11. AdminLayout + 5 pages bypass `useCurrentStore` cache

**Architecture, severity: high.** `AdminLayout.tsx:95-103` and 5 other files (`useDashboardData.ts:49`, `products/page.tsx:41`, `useMarketingPixels.ts:35`, `hero/page.tsx:37`, `domain/page.tsx:25`) each independently fetch `/api/v1/stores/${id}` — the exact thing `hooks/useCurrentStore.ts:57` already caches via in-flight promise dedup. CLAUDE.md explicitly flags this pattern.

**Fix:** replace direct fetches with `useCurrentStore(currentStoreId)`.

### 12. Status-badge components: 5 variants of the same thing

**Architecture, severity: high.** The shared `OrderStatusBadge.tsx` was designed to be reusable with a `namespace` prop and per-status color table. But 4 surface-specific forks exist:

- `abandoned-carts/_components/AbandonedCartStatusBadge.tsx`
- `returns/_components/ReturnStatusBadge.tsx`
- `notifications/_components/NotificationStatusBadge.tsx`
- `shipping-carriers/_components/ShipmentStatusBadge.tsx`
- `products/_components/StatusBadge.tsx` (odd-one-out with switch-style + dark variants)

The only real difference is the color map. `OrderStatusBadge` doesn't support a custom `colorMap?` prop, so each surface forked.

**Fix:** extend `OrderStatusBadge` to accept `colorMap?: Record<string, StatusStyle>` fallback. Delete 4 forks, migrate callers. Keep `products/StatusBadge.tsx` if dark-mode variants matter.

### 13. Modern storefront homepage staggered animation = 12 setTimeouts

**Perf/INP, severity: high.** `templates/modern/ProductGrid.tsx:39-51` schedules 12 timers (60ms stagger × 12 products) on mount, each causing inline-style re-renders. Main-thread pressure on first paint.

**Fix:** CSS-only: `animation-delay: calc(var(--i) * 60ms)` with `--i` set per card via style prop. Respect `prefers-reduced-motion`.

### 14. Hero JS-driven mount animation causes LCP flicker

**Perf/LCP, severity: high.** `templates/modern/Hero.tsx:22-27` does `useEffect(() => setTimeout(() => setMounted(true), 50))` toggling `opacity-0/translate-y-6 → visible`. LCP element flickers between hidden and visible after hydration.

**Fix:** remove the JS mount. Use CSS `@keyframes fadeIn` with `motion-safe:` + `motion-reduce:animate-none`.

### 15. `<div onClick>` redux — also present in announcement page preview

**A11y, severity: high.** `apps/admin/src/app/stores/[id]/announcement/page.tsx:133` — `<span className="underline cursor-pointer">` visually looks like a link but has no handler and is not interactive. Misleading cursor.

**Fix:** remove `cursor-pointer`, make it plain text (or convert to an actual link if it should navigate).

---

## P2 — Medium (polish; do after P0/P1)

### 16. Hardcoded palette colors where semantic tokens should be

Representative: `stores/[id]/settings/page.tsx` uses 11 different palette colors (`sky-100`, `rose-100`, `lime-100`, etc.) for decorative card icon backgrounds. `StatsGrid.tsx:24,30` uses `bg-violet-500` / `bg-emerald-500`. Status badges (`CategoryTable.tsx:157,162`, `products/_components/StatusBadge.tsx:16-27`, `coupons/_components/CouponsTable.tsx:40,201`, `CategoryForm.tsx:165`, `RelationSection.tsx:49`) use `emerald-*`/`amber-*` when `success`/`warning` tokens exist.

Also: `text-white` hardcoded on primary buttons (`payment-settings/page.tsx:111`, `template/page.tsx:174`, `branding/page.tsx:83`, etc.) → should be `text-primary-foreground` for theme flexibility.

**Fix:** sweep to semantic tokens where the color conveys status. Keep palette colors for genuinely decorative surfaces (template preview gradients, platform brand colors).

### 17. Duplicated DNS warning + status banner markup in 4 places

`_components/DomainSection.tsx:175-220`, `stores/new/_components/SuccessScreen.tsx:94-135`, `payment-settings/_components/ProviderCard.tsx:287-301`, `stores/[id]/domain/page.tsx:223-225` each hand-roll a `border-amber-200 bg-amber-50 text-amber-900` warning card. Same for success banners in 3 files.

**Fix:** extract `<Alert variant="warning|success|info">` using semantic tokens.

### 18. 11 inline "outline secondary" buttons duplicating `@ebda/ui` `Button variant="outline"`

`settings/page.tsx:333`, `orders/page.tsx:184`, `customers/page.tsx:163`, `payment-settings/page.tsx:215`, `announcement/page.tsx:104`, `pages/page.tsx:260`, `seo/page.tsx:134`, `categories/page.tsx:194`, `users/[id]/page.tsx:151`, `language/page.tsx:85`, `branding/_components/BrandPreview.tsx:33` — all define `px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted font-medium` inline.

**Fix:** replace with `<Button variant="outline">`.

### 19. Message-prop + callback-toast patterns across hooks

Three different patterns for "hook → toast":

- `useReturns.ts:7-32` — 18-key `messages` prop + `onSuccess`/`onError` callbacks
- `useBranding.ts:27-52` — 16-key `messages` prop but calls `useToast()` internally
- `useMarketingPixels.ts:24-74` — exposes `saveSuccess`/`saveError` flags, page renders strings
- `useAbandonedCarts.ts:20-21` — `onSaveSuccess`/`onSaveError` callbacks

This drives most of the 17 `eslint-disable-next-line react-hooks/exhaustive-deps` comments.

**Fix:** standardise on `useBranding`'s pattern (hook calls `useToast()` directly, drops `messages` prop). Removes ~80 LOC + most disable comments.

### 20. Template consistency — AddToCart button height variance

`modern` `py-2.5` (~40px), `elegant` `py-4` (~50px), `classic` **`py-0 h-auto` (~28px — below tap target)**, `bold`/`minimal` via shared. `minimal` OrderSummary checkout CTA is an underlined `<Link>` with no `min-h` — inconsistent IA for a primary action.

**Fix:** enforce `min-h-[44px]` (ideally `h-11`) on all primary card/checkout CTAs.

### 21. Tab components missing ARIA role="tablist" / role="tab" / aria-selected

`branding/_components/BrandingTabs.tsx:22-37`, `bulk/_components/BulkTabs.tsx:21,41` — visually behave like tabs but expose nothing to AT. Arrow-key nav not supported.

**Fix:** add `role="tablist"` on container, `role="tab"` + `aria-selected={isActive}` on each button, plus arrow-key handler.

### 22. Pill-group status filters missing `role="radiogroup"` / `aria-checked`

`products/_components/ProductFilters.tsx:54-67`, `stores/_components/StoresFilters.tsx:69-83` — visually radio-like but no semantics.

**Fix:** `role="radiogroup"` + `role="radio"` + `aria-checked`.

### 23. Storefront inconsistency — Elegant/Modern ProductCard quick-add hidden until hover, no focus-visible reveal

`templates/elegant/ProductCard.tsx:116` (`opacity-0` → hover), `templates/modern/ProductCard.tsx:161-179` (`isHovered` state), `templates/classic/ProductCard.tsx:74` (`translate-y-full`) — all inaccessible via keyboard.

**Fix:** add `group-focus-within:opacity-100` / `group-focus-within:translate-y-0`.

### 24. `max-height` CSS transitions (can't composite)

`templates/elegant/Header.tsx:196`, `bold/Header.tsx:185`, `minimal/Header.tsx:207`, `bold/Footer.tsx:89`, `classic/CategoryCard.tsx:58` animate `max-h-*` → main-thread layout per frame.

**Fix:** use `transform: scaleY()` with `transform-origin: top` or `grid-template-rows: 0fr → 1fr`.

### 25. `cartQuantities` object rebuilt every render; ProductCards unmemoized

`apps/web/src/app/products/ProductsClient.tsx:88-89` rebuilds a map each render. Combined with unmemoized `<ProductCard>` across all 5 templates, any cart action triggers 12× card re-renders.

**Fix:** `useMemo(() => ..., [cartItems])`; wrap each ProductCard in `React.memo` with equality on `product.id + quantityInCart + isInCompare`.

### 26. Storefront `fetchProducts` double-fetch on filter change

`ProductsClient.tsx:162-175` — effect deps `[page, search, categoryFilter, sortBy, fetchProducts]` + `fetchProducts` itself memoizes on `[search, categoryFilter, sortBy]` → changing a filter rebuilds `fetchProducts`, which re-runs the effect → 2 fetches per filter change.

**Fix:** split into two effects (filter-reset vs page-fetch), or use a ref for latest filters.

### 27. Web filter search input has no debounce

`ProductsFilterSidebar.tsx:53-59` — relies on form submit. Admin's products page uses `useDebouncedValue`. Inconsistent + mobile typing hammers API.

**Fix:** `useDebouncedValue(search, 300)` + auto-fetch like admin.

### 28. `*_Ar` text fields use `dir="rtl"` but not `lang="ar"`

Multiple admin forms (`BrandingIdentityTab.tsx`, `ContactInfoTab.tsx`, `products/[productId]/edit/page.tsx`, `products/new/page.tsx`, `TaxRateFormModal.tsx`, `ShippingZoneFormModal.tsx`, `CouponFormModal.tsx`, `AddOptionModal.tsx`, `AddValueModal.tsx`) set `dir="rtl"` but not `lang="ar"` → screen readers pronounce Arabic with English voice.

**Fix:** pair `dir="rtl"` with `lang="ar"`.

### 29. Marquee announcement bar has no pause control

`templates/modern/AnnouncementBar.tsx:64-93` — animated continuously, no user control. WCAG 2.2.2 violation (moving content >5s needs pause).

**Fix:** hover/focus pause CSS + small pause button.

### 30. Hidden secondary affordances don't `:focus-within`

See #23 above. Also: elegant Header logo Link has no focus-visible state (`templates/elegant/Header.tsx:88`).

---

## P3 — Low (defer / nice-to-have)

Representative items; see per-auditor reports for full list.

- **`components/AffiliatesTable.tsx:9`** — `onPageChange: (updater: (prev) => number)` leaks setState-style API to child. Should be `(page: number) => void`. (code-quality CODE-006)
- **`seo/page.tsx:71`** — only `as unknown as` cast in admin; API shape indeterminate. (code-quality CODE-008)
- **45 deep relative imports** `'../../../../../lib/api'`. Alias `@/` works elsewhere. (code-quality CODE-014)
- **Inline SVG duplication** — every template Header has 4-5 identical SVGs. ~600 lines of dup across 5 templates. Extract to `templates/shared/icons.tsx` (already exists for one icon).
- **`payment-settings/_components/ProviderCard.tsx:132`** — `dark:bg-destructive/30/20` (double slash). Tailwind silently drops. Dark mode broken for destructive banner.
- **`minimal/Header.tsx:27-42`** — scroll-hide translate doesn't respect `prefers-reduced-motion`.
- **`StoreContext.tsx:148-150`** — `api.setStoreId()` called in render (side effect). Move to effect.
- **`contexts/AuthContext.tsx:44-46`** — `/auth/me` fires on every mount, blocks first paint of cart/header. Should be SWR-style.
- **`<h1>` heading audit** — `ProductGrid.tsx` uses `<h2>` (correct), but verify no skipped levels at runtime.
- **`socket.io-client`** eagerly imported in admin `NotificationContext` but no page calls `subscribeToStore()` (per CLAUDE.md). Lazy-import.
- **`optimizePackageImports`** lists unused deps (`lucide-react`, `@heroicons/*`, `lodash`). Trim config.
- **`tabIndex`/`role="switch"`** inconsistency — some toggles use `peer` input + `<label>`, others use real `role="switch"` buttons. SR announces different element types.

---

## Cross-cutting compliance check — Vercel Web Interface Guidelines

Re-running the rule set against the P0–P3 findings:

| Rule                                         | Status      | Notes                                                              |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| Icon-only buttons need `aria-label`          | **Partial** | See #7                                                             |
| Form controls need `<label>`                 | **Partial** | See #5                                                             |
| `<button>` for actions, not `<div onClick>`  | **Partial** | See #3, #15                                                        |
| Decorative icons `aria-hidden="true"`        | **Good**    | Consistently applied in recent components                          |
| `aria-live="polite"` on async updates        | **Good**    | All OrderSummary totals ✅, toast uses `role="alert"`              |
| Focus-visible ring                           | **Good**    | Global `:focus-visible` rule in both globals.css                   |
| `outline-none` without focus replacement     | **Good**    | No violations found                                                |
| Form inputs: `autocomplete` + correct `type` | **Partial** | Admin mostly fine; verify on new forms                             |
| Never block paste                            | **Good**    | No `onPaste` + `preventDefault` found                              |
| `transition: all`                            | **Partial** | 73 uses across both apps; ~6 on non-compositor properties. See #24 |
| Honor `prefers-reduced-motion`               | **Partial** | Global rule present; #13, #14, #29 ignore it                       |
| `…` not `...`                                | **Good**    | Loading states use `…` throughout                                  |
| Images need explicit `width`/`height`        | **Partial** | See #10                                                            |
| Below-fold `loading="lazy"`                  | **Good**    | next/image default                                                 |
| Above-fold `priority`                        | **Good**    | All 5 heroes use it — but miss `sizes` (#2)                        |
| Large lists virtualized                      | **N/A**     | No >50-row tables observed                                         |
| URL reflects state                           | **Good**    | Filters use query params                                           |
| `touch-action: manipulation`                 | **Missing** | Not set globally; should add                                       |
| `overscroll-behavior: contain` in modals     | **Missing** | Modals don't set this                                              |
| `color-scheme: dark` on `<html>`             | **Missing** | Should add when `dark` class present                               |
| `<meta name="theme-color">`                  | **Unknown** | Verify in `layout.tsx` metadata                                    |
| `Intl.DateTimeFormat`/`Intl.NumberFormat`    | **Good**    | `next-intl` + `formatPrice` utility                                |
| `translate="no"` on brand names              | **Missing** | No occurrences                                                     |
| `autoFocus` justified                        | **Good**    | Not abused                                                         |

Easy wins from this list: `touch-action: manipulation` on `html` + `overscroll-behavior: contain` on modal containers + `color-scheme: dark` on `<html>` when dark. ~10 lines of CSS total.

---

## Things working well (keep doing)

Positive patterns worth preserving:

- **Every user-facing string behind `useT`** with consistent per-page namespaces. 0 hardcoded strings in scanned files.
- **`role="alert"` / `aria-live` discipline** on all form errors and totals. Toast component propagates correctly.
- **Logical-property migration** covered the vast majority of `ml-/mr-/pl-/pr-/text-left/text-right`. Remaining hits are <20.
- **44×44 tap targets** on cart quantity steppers across all 5 template CartTables (set during the polish pass).
- **Zero `any`** across 190+ admin files.
- **Zero `console.log`** / `TODO` / `FIXME` in the scanned tree.
- **`<a>` / `<Link>` vs `<button>`** usage is correct everywhere except the 2 `<div onClick>` exceptions (#3, #15).
- **Design tokens architecture** is sound — `primary` / `info` / `success` / `warning` / `destructive` exist and have light/dark modes. Inconsistent adoption (#16), not broken architecture.
- **Error boundaries:** `error.tsx` + `not-found.tsx` + `global-error.tsx` are all localized (global-error via cookie-read).
- **`useCurrentStore`** is well-designed (in-flight dedup + across-nav cache) — it's just underused (#11).
- **`OrderStatusBadge`** is well-designed — the issue is its consumers forked instead of extending (#12).

---

## Recommended execution order

If the user wants to land these:

1. **Sweep 1 (30 min, mechanical)** — fix #6 (missing `type="button"`) + #7 (icon-button `aria-label`) + #9 (residual RTL) in one subagent pass across both apps.
2. **Sweep 2 (30 min, mechanical)** — fix #10 (raw `<img>` → `<Image>`) + #18 (inline outline buttons → `Button variant="outline"`).
3. **Fix 3 (15 min, targeted)** — #3 (PixelPlatformCard div→button), #4 (orders confirm()→modal + reject prompt()→modal), #15 (dead span).
4. **Perf pass (1–2h, architectural)** — #1 (homepage SSR), #2 (hero `sizes`), #13 (stagger → CSS), #14 (hero mount animation → CSS), #25 (ProductCard memo + cartQuantities useMemo), #27 (search debounce).
5. **Architecture pass (1h)** — #11 (useCurrentStore adoption), #12 (badge consolidation), #19 (hook toast standardization).
6. **Polish pass (1h)** — #16 (semantic tokens), #17 (Alert component), #21–22 (ARIA roles on tabs/pills), #28 (lang="ar" on Arabic inputs).
7. **Defer** — P3 items as opportunistic cleanup.

Total high-impact work: **~4–6 hours**. After that, the admin and storefront meet production quality bar for Kuwait-market e-commerce SaaS.

---

## Source reports (raw audits)

- Admin UI: 60 findings, `ui-auditor` agent
- Web UI: 60 findings, `ui-auditor` agent
- Perf: ~35 findings, `perf-auditor` agent
- Code quality: 28 findings, `code-auditor` agent
- Vercel Labs Web Interface Guidelines (fetched 2026-04-25)
- `ui-ux-pro-max` UX database (20 accessibility + touch rules)
