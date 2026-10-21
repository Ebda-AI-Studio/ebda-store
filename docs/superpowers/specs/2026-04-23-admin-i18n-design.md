# Admin Dashboard Internationalization — Design Spec

**Status:** scoping complete, awaiting approval + translator sourcing before implementation.
**Effort:** 1–2 weeks engineering + parallel translation work.
**Risk:** medium — RTL regressions are hard to catch without browser review of every page.

## Why this is overdue

The storefront (`apps/web`) has been bilingual EN/AR since day one — every customer-facing page runs through `useLanguage()` and renders Arabic with `dir="rtl"`. The admin dashboard (`apps/admin`) is English-only. Store owners whose first language is Arabic currently manage their bilingual store through an English-only control panel. That's a product gap every tenant in Egypt (the primary market) hits.

## Scope

- Wrap ~80 admin `.tsx` files' user-facing strings in a translation helper.
- Add language toggle + locale switcher to the admin header.
- Swap directional Tailwind utilities (`ml-*`, `mr-*`, `left-*`, `right-*`, `rounded-l-*`, `rounded-r-*`) for logical-property variants (`ms-*`, `me-*`, `start-*`, `end-*`, `rounded-s-*`, `rounded-e-*`) so RTL mirrors layout automatically.
- Arabic translations for every string (outsourced or in-house).

## Scoping questions (needed before starting)

1. **Who owns Arabic translations?** — In-house (a team member who can sign off on commerce terminology) vs. contracted translator. Translation quality for terms like "SKU", "Loyalty Tier", "Abandoned Cart", "COD" matters more than generic UI copy. If contracted, set up a glossary first.
2. **Per-tenant or per-user language preference?** — Should the admin language follow the logged-in user (stored in `user.settings.language`), or the store (stored in `store.settings.adminDefaultLanguage`)? Recommendation: per-user, since staff may speak different languages than the owner.
3. **URL routing vs. cookie-based locale?** — `/en/stores/[id]/products` vs. a cookie + query-free URLs. Recommendation: **cookie-based**, same as the storefront. Admin URLs are bookmarked and shared internally; adding a locale prefix churns every bookmark.
4. **Formats** — does Arabic admin use Arabic-Indic digits (٠١٢٣) in tables + forms, or Latin digits always? Recommendation: Latin digits for money/SKUs/IDs (global e-commerce standard); Arabic-Indic only for prose counts. Document in the style guide.

## Recommended library: `next-intl`

Rationale:

- Native Next.js App Router integration; works with Server Components + Client Components.
- Arabic RTL + pluralization + date/number formatting built in.
- Good type inference via `useTranslations()` hook.
- Small runtime (~7 kB gz).

Alternatives considered and rejected:

- `i18next` — more boilerplate, weaker TS support out of the box.
- `react-intl` — heavier runtime, less App Router–friendly.
- DIY `t(en, ar)` helper like the storefront's — fine for a single-locale-at-a-time app, but admin needs plural/number formatting + eventually more than 2 locales (Farsi? French?).

## Migration order (6 steps, each independently shippable)

### Step 1 — Install + scaffold `next-intl`

- `npm install --workspace apps/admin next-intl`
- `apps/admin/src/i18n/messages/en.json` — empty object.
- `apps/admin/src/i18n/messages/ar.json` — empty object.
- `apps/admin/src/i18n/config.ts` — locale detection from cookie.
- `apps/admin/src/app/layout.tsx` — wrap root in `NextIntlClientProvider`.
- Ship. No visible change; infrastructure in place.

### Step 2 — Add language switcher to admin header

- New `apps/admin/src/components/AdminLanguageSwitcher.tsx` — 2-button toggle that writes `admin-lang` cookie + reloads the current route.
- Mount in `AdminLayout.tsx` header.
- Still no string translations, but the toggle exists so QA can flip locale for later steps.

### Step 3 — Wrap strings page-by-page

For each admin page (ordered by traffic — `stores/[id]/page.tsx` first, settings pages, then inventory/orders, finally rarely-used pages):

- Replace `"Dashboard"` etc. with `t('dashboard.title')`.
- Add the key to both `en.json` and `ar.json`, using English text in **both** files as a placeholder.
- Ship the page wrapped. Still shows English in both locales — the infrastructure is now real, the translations come later.

Commit per page. After ~80 pages, `en.json` has every string.

### Step 4 — Bulk-translate via glossary

- Export `en.json` to the translator.
- Translator returns an `ar.json` with Arabic values + a glossary doc.
- Code review the glossary (commerce terminology) internally.
- Ship `ar.json`. Every admin surface now renders in Arabic when the user flips the switch.

### Step 5 — Logical-properties RTL sweep

- Automated sweep: `ml-*` → `ms-*`, `mr-*` → `me-*`, `left-*` → `start-*`, etc. across all `apps/admin/src/**/*.tsx`.
- Add `dir={locale === 'ar' ? 'rtl' : 'ltr'}` to the root admin `<div>`.
- Chrome-verify every admin page in Arabic:
  - navigation alignment
  - table headers
  - form labels + inputs
  - modals + toasts
  - sidebar / nav icons
  - charts (axis labels, tooltips)
- Fix layout bugs inline. Expect ~5–10 broken layouts; most are icons needing flipping (`rotate-180` on directional arrows).

### Step 6 — Number + date formatting pass

- Replace manual `toLocaleString()` + ad-hoc date helpers with `useFormatter()` from `next-intl`.
- Verify money always uses Latin digits regardless of locale (per the scoping decision above).

## Files touched (estimate)

- 80 admin `.tsx` files — string wrapping.
- 2 locale JSON files — grow from {} to ~400 keys.
- `AdminLayout.tsx` — language switcher mount.
- `apps/admin/tailwind.config.js` — no change (logical properties work out of the box).
- ~60 files with directional Tailwind classes to sweep.

## Open technical questions

- **Do we route admin URLs with a locale prefix (`/en/stores/…`) or stay on the current structure?** Recommendation above is cookie-based — revisit if we want per-locale admin URLs for shareable links in product-internal docs.
- **How do we handle user-generated Arabic content (store names, product descriptions)?** The existing `name / nameAr` + `description / descriptionAr` columns on Store / Product are unchanged — this spec is about admin UI strings only. Keep that separation clean.
- **Do RTL layouts need per-template-admin aesthetic overrides?** No — the admin is a single design, not tenant-themed. Sidestep this entirely.

## What to watch out for

1. **Date-picker libraries** — if the admin uses a date-picker that hardcodes weekday labels, it needs its own i18n config.
2. **Charts** — recharts / chart.js axes need `direction: 'rtl'` + mirrored tooltips.
3. **Toast notifications** — any custom toast with a directional slide-in animation needs to flip direction in RTL.
4. **File uploaders** — placeholder text + error messages.
5. **Code inputs / JSON editors** — those stay LTR regardless of locale (show code in its natural direction).

## Verification checklist

Before considering admin i18n shipped:

- [ ] Every admin page renders in EN and AR without layout regression.
- [ ] Language switcher persists across navigations + login/logout.
- [ ] No English string leaks in Arabic mode (check by grepping admin HTML output).
- [ ] Error messages (API errors bubbled to toast) are localized.
- [ ] Form validation messages are localized.
- [ ] Table sorting + pagination labels are localized.
- [ ] Empty-state copy on every list page is localized.
- [ ] All directional icons mirror correctly.
- [ ] Cypress/Playwright coverage exists for the critical admin flows in AR mode (or browser QA plan at minimum).

## Not in scope

- Translating admin _email templates_ (those are a separate layer — `apps/api/src/services/email.service.ts`; do in a follow-up).
- Translating notification SMS / WhatsApp templates (same — `apps/api/src/services/notification-dispatcher.service.ts`).
- Adding a third language (Farsi, French, etc.) — the infrastructure supports it, but scope this separately when there's a market need.
