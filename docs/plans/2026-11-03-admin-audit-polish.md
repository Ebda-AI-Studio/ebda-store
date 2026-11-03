# Admin audit polish (2026-11-03)

Source: business/ebda/audits/2026-11-03-admin-editor-impeccable-audit.md sections 2.0-2.9. Editor (2.10) is out of scope (branch feat/editor-theme-tiers-spacing).

## Tasks
1. G-1: remove OneSignal from apps/admin (OneSignalInit, FocusTopBar nudge, providers, react-onesignal dep, SDK worker, CSP hosts). Storefront (apps/web) untouched. Test: no admin source imports/loads OneSignal; admin CSP has no onesignal host.
2. G-2/G-3/M-1: `route-feature-gates` (path -> feature key) read in `stores/[id]/layout.tsx` from the one AdminFeatureProvider, so a gated page renders the existing FeatureUpgradeGate card and never mounts/fetches. `<PlanGate>` + `isPlanGateError` for a 402/403 that still reaches a page. `apiRequest` never surfaces raw "Request failed with status 4xx"/"Feature not available" (localized plan message instead). Dashboard summary skips gated calls. Tests: gate map, PlanGate, api 402/403 message.
3. P-1/P-2 products toolbar overflow (secondary actions into a "more" menu), empty-state CTA, status filter not preselected on empty catalog.
4. G-4..G-9: single language switcher, locale-aware formatDate/DateTime/Number/Price (Latin digits per NUMERALS-1, Arabic month names, ج.م), sidebar chip truncation, one h1 per page, Egyptian full sentences in admin messages (buttons stay neutral), focus-mode hint.
5. Page findings: A-1, D-1, D-2, S-1, S-3, S-4, S-5, S-6, M-1, M-2, stock tab strip grouping, settings orphan card.

## Tests (TDD where logic)
route-feature-gates, PlanGate/isPlanGateError, api error normalisation, format helpers, OneSignal-absent guard, i18n parity/digits/literal gates stay green.

## Must NOT change
Storefront OneSignal, API contracts, editor (builder/**), plan/feature semantics, Latin-digit policy (NUMERALS-1), no orange.
