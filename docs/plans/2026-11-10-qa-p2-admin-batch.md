# 2026-11-10 QA-P2 admin batch (F6, F2, QA P2-1..10)

Branch `fix/qa-p2-admin-batch`. Pre-launch (Nov 11) fix batch. One PR, no merge, no deploy.

Sources: `business/ebda/audits/2026-11-03-qa-store-full-run.md` rows P2-1..P2-10 (lines 34-43);
`business/ebda/VERIFY-SWEEP-2026-11-02.md` rows F2 (line 54) and F6 (line 57);
closure status `business/ebda/audits/2026-11-09-admin-audit-closure.md`.

Avoids every file of PR #510 (`fix/preqa-p2-batch`) and the rate-limiter / marketing files other agents own.

## QA P2 status on `origin/main` 926ee0cdb

| Row   | Finding                                                 | Status on main                                                                                                                                                                                                                                                      | This PR                                                                                                                                                                      |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1  | Storefront sign-up wipes the first name                 | PARTIAL: #401 (cd6a11d48) functional updater + submit disabled until hydrated. Still fails: text typed BEFORE hydration lives only in the DOM; React 18 keeps it on hydrate but the next re-render (typing in the next field) writes the empty state back over it   | Adopt the pre-hydration DOM values into state on mount (`adoptTypedBeforeHydration`), register + login + forgot-password. Test: SSR + `hydrateRoot` + type in the next field |
| P2-2  | AI SEO writes Arabic into the English fields            | PARTIAL: server prompt + `seoLanguagesOk` retry/422 (#401), store SEO page client guard (#402). Product edit and category form apply the AI answer with no language guard. "Persisted without Save": not reproducible, `/ai/seo` only reads + caches the suggestion | `applyAiSeoSuggestion` (one helper, uses `normalizeLanguagePair`) on all three `/ai/seo` callers + product AEO pair                                                          |
| P2-3  | Branding save fires 5 PUTs                              | ALREADY FIXED: one `PUT /branding-bundle` (#400 7383832b0 API, #402 29721c0ec client)                                                                                                                                                                               | Class: no other admin form fires a settings burst (grep of `Promise.all` + writes: only per-row batches)                                                                     |
| P2-4  | Product create stays on /products/new                   | ALREADY FIXED: #403 (4211d5b75)                                                                                                                                                                                                                                     | Class: the 7 other `/new` pages all navigate away on success (grep)                                                                                                          |
| P2-5  | Default category has no Arabic name                     | ALREADY FIXED for new stores (#401) + lazy backfill on the merchant category list (#486 d3568d0a5)                                                                                                                                                                  | none                                                                                                                                                                         |
| P2-6  | Dashboard 402 upgrade modal                             | ALREADY FIXED in code: `apiGetQuiet` + plan-refusal memo (#397 17d4058b2)                                                                                                                                                                                           | none                                                                                                                                                                         |
| P2-7  | Product/category image shape, create omits categoryId   | ALREADY FIXED: #401                                                                                                                                                                                                                                                 | none                                                                                                                                                                         |
| P2-8  | Storefront email verification, no resend                | ALREADY FIXED: resend on check-email + login (#486)                                                                                                                                                                                                                 | none                                                                                                                                                                         |
| P2-9  | Plan naming mismatch                                    | ALREADY FIXED: `PLAN_LABELS_*` (#399 e7f17ce83) + ratchet test on hard-coded names (#486)                                                                                                                                                                           | none                                                                                                                                                                         |
| P2-10 | Admin stall; sign-in under the limiter shows no message | ALREADY FIXED in code: stall (#400), admin sign-in 429 message (#397). Storefront sibling still shows the API's raw English ("Too many requests", "Invalid email or password") in the Arabic UI                                                                     | `authRefusalText` on storefront login, register, forgot-password                                                                                                             |

## F6 - onboarding step 7 raw key

Root: 2026-11-02 `tTemplates(store.template)` read a key that never existed (raw `onboarding.flow.template`). #389 replaced it with
`getLook(store.template)`, but `store.template` is a template id (`qamar`) and looks are `qamar.atelier`, so the row now shows
"—" for every real store. Fix: name the chosen look (`store.look`), else the template's first look family name.
Guard: (1) the OnboardingFlow test renders the live step with the REAL ar and en messages through `NextIntlClientProvider`
and fails on any `MISSING_MESSAGE`; (2) `admin-i18n-keys-resolve.test.ts` now also checks that every `useT('ns')` namespace and
every template-literal key prefix resolves to a group in BOTH locales (a key missing from both files is caught, not just parity).

## F2 - admin search

ALREADY FIXED: Orders debounces through the shared `useDebouncedValue` since #2398 (26eae23c0) with a regression test
(`orders/page.search-debounce.test.tsx`, #389); Invoices has `SearchInput` + API `q` (Zod `listQuery`, #389 0e0591f94).
Class sweep: all 15 admin search boxes go through `SearchInput` or `useDebouncedValue`. No code change.

## Tests (each red without its fix)

- `tests/unit/register-first-name.test.tsx`: pre-hydration text survives the next field; RATE_LIMITED shows Arabic.
- `tests/unit/web-auth-refusal.test.ts`: code -> sentence map.
- `apps/admin/src/app/stores/[id]/seo/language-guard.test.ts` (or existing `seo-language-guard.test.ts`): `applyAiSeoSuggestion`.
- `tests/unit/admin-ai-seo-callers-guarded.test.ts`: every `/ai/seo` caller goes through the guard.
- `OnboardingFlow.test.tsx`: look name shown, no missing message in ar/en.
- `tests/unit/admin-i18n-keys-resolve.test.ts`: namespace + prefix groups.

## Rulings

- Ruling QAP2-F2-1 - F2 ships no code: Orders already debounces through `useDebouncedValue` (300 ms, the hook `SearchInput` uses) and Invoices already has `SearchInput` + `q`. Evidence: `orders/page.tsx:86`, `orders/page.search-debounce.test.tsx`, `invoices/page.tsx:83`, `fiscal-document.routes.ts:46`. The 2026-11-02 sweep's "3 requests for 3 keys" on Orders is inferred to be keystrokes typed more than 300 ms apart by the browser driver. Cost if wrong: Orders still sends one request per key live; settle with a logged-in Network-panel check typing fast.
- Ruling QAP2-AUTHCTX-1 - `apps/web/src/contexts/AuthContext.tsx` `login()` still falls back to `'Failed to login'`; left unchanged because no component renders that error string (grep: the context exports `login`, nothing in `apps/web/src` calls it; every storefront form calls `api.login` and maps the refusal with `authRefusalText`). Cost if wrong: a future caller that renders it shows English to an Arabic shopper.
- Ruling QAP2-P25-1 - QA P2-5's lazy backfill (#486) repairs a pre-fix default category only when the merchant opens the category list; no one-off backfill runs here (no deploy, no prod write in this PR). Cost if wrong: an existing store that never opens Categories keeps "Products" in its Arabic storefront strip.
