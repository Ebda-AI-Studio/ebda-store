# Admin Mobile/Tablet UX + Speed Sprint

**Goal:** make the FWB merchant admin (`app.forcemediakw.com/stores/[id]/…`) genuinely good on phone/tablet — the device it's most used on — and fix the perceived-speed gaps. Grounded in the 2026-06-09 admin deep audit + the in-session mobile/touch audit.

**Why now:** Ahmad: "it will be most used on mobile … touch + the speed of loading." Today: client-heavy pages blank for 3–5s (only 1 `loading.tsx` exists platform-wide); ~13 of ~20 data tables overflow on mobile (only 7 use the existing `components/mobile/DataTable.tsx`); touch targets are inconsistent.

**Principle:** platform-level + reuse existing primitives (`components/mobile/DataTable.tsx`, `ProductsLoadingSkeleton.tsx`). No new design language — make the existing one responsive + fast.

---

## Wave 1 — Perceived speed: route loading skeletons (HIGHEST value)

The single biggest "feels slow" fix. Next.js App Router renders `loading.tsx` instantly while the page's data resolves. Today only 1 route has one.

- **Add `loading.tsx`** to the client-heavy / slow routes the audit flagged blank-for-3–5s: `insights/*` (dashboard, products, cohorts, funnel), `ai-usage`, `analytics`, `customers`, `loyalty/*`, `finance/*`, `inventory/*`, plus the top-level `stores/[id]` dashboard.
- Each `loading.tsx` returns a lightweight skeleton matching that page's shape (header bar + KPI cards row + a table/chart skeleton). Reuse/extract a shared `<AdminSkeleton variant="table|cards|chart|detail" />` in `components/mobile/` (or `components/ui/`) so they're consistent + one-line per route.
- **Preview-unsaved iframe**: add a spinner + keep the prior frame until the new one paints (audit §"Preview UX": blanks 5–7s, reads as broken).

**Acceptance:** every flagged route shows a skeleton within ~100ms instead of a white screen; `find apps/admin/src/app -name loading.tsx | wc -l` jumps from 1 to ≥12.

## Wave 2 — Responsive data tables (touch + mobile readability)

~13 table surfaces overflow horizontally on phones. Route them through the existing `components/mobile/DataTable.tsx` (already used by 7) OR a stacked-card renderer < `sm`.

- Audit the existing `mobile/DataTable.tsx` API; if it already does card-stacking on mobile, migrate the remaining tables to it: `StoresTable`, `MembersTable`, `ShippingZonesTable`, `CouponsTable`, `TaxRatesTable`, `AffiliatesTable`, `StockLevelsTable`, `StockMovementLog`, customers, loyalty/transactions, returns, variants.
- Each row's primary tap action (open detail) must be a ≥44px target; row action menus become a bottom-sheet/overflow on mobile, not tiny inline icons.

**Acceptance:** no horizontal scroll on any admin table at 375px width; every migrated table renders as readable stacked cards on mobile.

## Wave 3 — Touch targets + tap ergonomics (cross-cutting)

- Enforce ≥44×44px on all interactive controls on mobile: icon buttons, table-row actions, tab bars, toggle rows, dropdown triggers. Add a lint-able utility class (`min-h-11 min-w-11` / `touch-target`) and apply it.
- Mobile bottom-nav + sticky save bars: confirm safe-area insets + no overlap with the storefront-style bottom bar pattern.
- Bigger hit areas on the per-store sidebar/hub navigation (it's dense).

**Acceptance:** every interactive control ≥44px on mobile; no mis-tap clusters on the dense settings hubs.

---

## Execution

- One wave per PR (reviewable). Wave 1 first (biggest perceived-speed win), then 2, then 3.
- Each PR: platform-level (no per-store branches), prettier 3.8.3 clean, reuse the existing mobile primitives, RTL-checked (admin is bilingual).
- **Verify by rendering** (the reliability rule): after each wave deploys, drive the admin on a phone-width viewport (Chrome devtools / the browser tools) and confirm skeletons appear + tables stack + targets are tappable — don't claim done on code alone. Budget 2–4 refinement rounds per wave + Ahmad sign-off (UI rule #10).
