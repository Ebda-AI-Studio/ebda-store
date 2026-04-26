# Admin i18n + Page Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the two items we punted: (a) wrap ~51 admin `.tsx` files' visible strings with `t()` behind next-intl (infrastructure already shipped in commit `14fa242`), and (b) extract ~15 admin pages over 500 lines into `_components/` subfolders so each page.tsx stays under ~400 lines. Ship in one coordinated sequence so each page is touched exactly once.

**Architecture:** Single-pass per page: **extract first, wrap second, RTL-sweep third, commit**. The extract step makes i18n wrapping mechanical (each subcomponent owns a bounded string set). English lives in both `en.json` and `ar.json` as placeholder until the translator delivers — this keeps the migration shippable without blocking on translation. A single `useT` re-export + key-naming convention (`page.section.key`) gives us a predictable editing pattern.

**Tech Stack:** next-intl 4.9.1 (already installed), Tailwind logical properties (`ms-*`/`me-*`/`start-*`/`end-*`), per-page `_components/` folders (Next.js App Router convention — underscore-prefixed folders are ignored by the router).

---

## File Structure

Before tasks: agree on these conventions, apply them uniformly.

**Translation keys** — `{page}.{section}.{key}` e.g. `products.list.emptyTitle`, `branding.logo.uploadHint`. Common repeats (`save`, `cancel`, `delete`, `edit`, `loading`) live under `common.*`. Arabic is identical to English until translator delivers.

**Per-page extraction** — `apps/admin/src/app/stores/[id]/<page>/_components/<PascalName>.tsx` for JSX, `_hooks/use<Name>.ts` for data/state hooks. Types local to the page stay in a single `_components/types.ts` file.

**Shared extraction** — when a pattern appears on **3+ pages**, it graduates to `apps/admin/src/components/` (same home as `Toggle.tsx`, `ConnectionStatus.tsx` from the earlier pass).

**RTL sweep** — mechanical find/replace per page, reviewed in diff before commit:

- `ml-*` → `ms-*`, `mr-*` → `me-*`
- `left-*` → `start-*`, `right-*` → `end-*`
- `rounded-l-*` → `rounded-s-*`, `rounded-r-*` → `rounded-e-*`
- `border-l-*` → `border-s-*`, `border-r-*` → `border-e-*`
- `pl-*`/`pr-*` → `ps-*`/`pe-*`

Leave `text-left`/`text-right` alone — those are intentional alignment. Leave `-rotate-*` on directional icons; we add `rtl:rotate-180` conditionally.

---

## Task 0 — Foundation: key helper + namespace scaffold

**Files:**

- Create: `apps/admin/src/i18n/useT.ts` — thin re-export + typed key shape
- Modify: `apps/admin/src/i18n/messages/en.json` — add top-level namespaces
- Modify: `apps/admin/src/i18n/messages/ar.json` — mirror en.json structure

- [ ] **Step 1: Add useT helper**

```ts
// apps/admin/src/i18n/useT.ts
'use client';
import { useTranslations } from 'next-intl';
export const useT = useTranslations;
export type { Locale } from './config';
```

- [ ] **Step 2: Seed namespace scaffolding in en.json + ar.json**

Add these top-level keys to both files (values identical — English placeholder in Arabic):

```json
{
  "common": { "save": "Save", "cancel": "Cancel", ... },
  "nav": { ... existing ... },
  "dashboard": {},
  "stores": {},
  "products": {},
  "orders": {},
  "customers": {},
  "analytics": {},
  "settings": {},
  "branding": {},
  "coupons": {},
  "shipping": {},
  "tax": {},
  "inventory": {},
  "pwa": {},
  "affiliates": {},
  "bulk": {},
  "abandonedCarts": {},
  "returns": {},
  "marketingPixels": {},
  "pages": {},
  "navigation": {},
  "notifications": {},
  "loyalty": {},
  "paymentSettings": {},
  "hero": {},
  "announcement": {},
  "features": {},
  "template": {},
  "seo": {},
  "language": {},
  "domain": {},
  "categories": {},
  "reviews": {},
  "audit": {},
  "auth": {},
  "users": {}
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/i18n
git commit -m "chore(admin/i18n): namespace scaffold + useT helper"
```

---

## Task Ladder — Page-by-page (traffic-weighted order)

Each **page task** below follows the same 5-step shape. Do them in this order — highest-traffic first so the most-seen surfaces localize first and we catch key-naming issues before they propagate.

**Page task shape:**

1. Extract `page.tsx` chunks into `_components/` + `_hooks/` until page.tsx ≤ 400 lines.
2. Wrap every visible string (JSX text, `aria-label`, `placeholder`, `title`, `alt`, toast/error copy) with `t('page.section.key')`. Add the key to both `en.json` and `ar.json` with the same English value.
3. RTL sweep — run the logical-property replacements in every file touched; verify in diff.
4. Chrome-verify the page in EN and AR (flip `admin-lang` cookie; hard reload).
5. Commit with `refactor(admin/<page>):` or `feat(admin/<page>):` prefix (lowercase, ≤100-char body lines).

### Task 1 — `stores/[id]/page.tsx` (dashboard, 971 lines)

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/page.tsx`
- Create: `apps/admin/src/app/stores/[id]/_components/StatsGrid.tsx`
- Create: `apps/admin/src/app/stores/[id]/_components/RecentOrdersCard.tsx`
- Create: `apps/admin/src/app/stores/[id]/_components/QuickActions.tsx`
- Create: `apps/admin/src/app/stores/[id]/_components/StoreHealthBanner.tsx`
- Create: `apps/admin/src/app/stores/[id]/_hooks/useDashboardMetrics.ts`
- Modify: `apps/admin/src/i18n/messages/en.json`
- Modify: `apps/admin/src/i18n/messages/ar.json`

- [ ] **Step 1: Identify the JSX chunks to extract** — read `page.tsx` and list every section returned by the page (stats grid, recent orders, quick actions, health banner, etc.). Plan one subcomponent per section; co-locate the data-fetching hook.

- [ ] **Step 2: Extract one subcomponent at a time, verifying the page still renders between each.**

For each chunk:

- Create `_components/<Name>.tsx` with a typed prop interface.
- Move the JSX + local state + local handlers.
- Replace the JSX in `page.tsx` with `<Name {...}/>`.
- Run `npx tsc --noEmit` from `apps/admin` — expect zero errors.

- [ ] **Step 3: Wrap strings with `t()`**

For each subcomponent:

- `import { useT } from '@/i18n/useT'`
- `const t = useT('stores.dashboard');` (scoped namespace)
- Replace visible string literals with `t('key')`. Example:
  ```tsx
  <h2>Recent Orders</h2>
  // becomes
  <h2>{t('recentOrders.title')}</h2>
  ```
- Add every new key to both JSON files with the English value in both.

- [ ] **Step 4: RTL sweep on all touched files**

Run inside `apps/admin/src/app/stores/[id]/`:

```bash
perl -pi -e 's/\bml-(\d+|auto|px)/ms-$1/g; s/\bmr-(\d+|auto|px)/me-$1/g; s/\bleft-(\d+|auto|px|\[.*?\])/start-$1/g; s/\bright-(\d+|auto|px|\[.*?\])/end-$1/g; s/\brounded-l-/rounded-s-/g; s/\brounded-r-/rounded-e-/g; s/\bpl-(\d+|px)/ps-$1/g; s/\bpr-(\d+|px)/pe-$1/g' page.tsx _components/*.tsx
```

Review `git diff` — revert any false positives (e.g. `left-0` inside a CSS keyframe string).

- [ ] **Step 5: Chrome-verify + commit**

```bash
# dev server on :3001, visit /stores/<id>, flip admin-lang cookie to 'ar', reload
# verify: layout mirrors, no horizontal scroll, tap targets still 44x44
npm run build --workspace apps/admin  # must pass
git add apps/admin/src apps/admin/src/i18n/messages
git commit -m "refactor(admin/dashboard): extract + wrap i18n + rtl sweep"
```

### Task 2 — `stores/[id]/settings/page.tsx` (396 lines, but all forms)

Follows the same 5-step shape. Key slices: `StorePreferencesForm`, `PaymentMethodsForm`, `CurrencyForm`, `LocaleForm`. Namespace: `settings.*`.

### Task 3 — `stores/[id]/products/page.tsx` (576 lines)

Extract into: `ProductsToolbar`, `ProductsTable`, `BulkActionsBar`, `ProductFilters`, `EmptyProductsState`. Namespace: `products.list.*`. Product edit/new pages are smaller — do those right after in the same commit.

### Task 4 — `stores/[id]/orders/page.tsx` (571 lines)

Extract into: `OrdersFilters`, `OrdersTable`, `OrderStatusBadge` (move to shared `src/components/` — used by returns + abandoned-carts). Namespace: `orders.list.*`.

### Task 5 — `stores/[id]/notifications/page.tsx` (846 lines)

Already partially extracted in commit `41195a0`. Finish the job: remaining slices `ChannelsGrid`, `TemplatePreview`, `TestSendPanel`. Namespace: `notifications.*`.

### Task 6 — `stores/[id]/loyalty/page.tsx` (821 lines)

Extract into: `TiersConfig`, `RewardsCatalog`, `EarnRulesForm`, `MembersTable`. Namespace: `loyalty.*`.

### Task 7 — `stores/[id]/shipping-carriers/page.tsx` (795 lines)

Already partially extracted in commit `a8642c4`. Finish: `CarrierConnectModal`, `CarrierZonesTable`, `CarrierCredentialsForm`. Namespace: `shipping.carriers.*`.

### Task 8 — `stores/[id]/tax/page.tsx` (788 lines)

Extract into: `TaxRegionsTable`, `TaxRulesForm`, `TaxExemptionsList`. Namespace: `tax.*`.

### Task 9 — `stores/[id]/inventory/page.tsx` (774 lines)

Extract into: `StockLevelsTable`, `LowStockAlerts`, `StockMovementLog`, `AdjustStockModal`. Namespace: `inventory.*`.

### Task 10 — `stores/[id]/pwa/page.tsx` (756 lines)

Extract into: `PwaBranding`, `PwaManifestPreview`, `PwaInstallBanner`, `PwaIconUploader`. Namespace: `pwa.*`.

### Task 11 — `stores/[id]/branding/page.tsx` (724 lines)

Extract into: `ColorPalettePicker`, `TypographyPicker`, `LogoUploader`, `FaviconUploader`, `BrandPreview`. Namespace: `branding.*`.

### Task 12 — `stores/[id]/coupons/page.tsx` (720 lines)

Extract into: `CouponsTable`, `CouponFormModal`, `CouponUsageStats`. Namespace: `coupons.*`.

### Task 13 — `stores/[id]/affiliates/page.tsx` (719 lines)

Extract into: `AffiliatesTable`, `AffiliateCommissionForm`, `PayoutsHistory`. Namespace: `affiliates.*`.

### Task 14 — `stores/[id]/bulk/page.tsx` (694 lines)

Extract into: `BulkImportWizard`, `BulkExportPanel`, `ImportHistoryTable`. Namespace: `bulk.*`.

### Task 15 — `stores/[id]/abandoned-carts/page.tsx` (588 lines)

Extract into: `AbandonedCartsTable`, `RecoveryCampaignForm`, `CartDetailsDrawer`. Namespace: `abandonedCarts.*`.

### Task 16 — `stores/[id]/analytics/page.tsx` (597 lines)

Extract into: `AnalyticsDateRange`, `RevenueChart`, `TopProductsTable`, `TrafficSourcesCard`. Namespace: `analytics.*`.

### Task 17 — `stores/[id]/returns/page.tsx` (535 lines)

Extract into: `ReturnsTable`, `ReturnStatusFilter`, `ReturnDetailsDrawer`. Namespace: `returns.*`. Reuse shared `OrderStatusBadge` from Task 4.

### Task 18 — `stores/[id]/marketing-pixels/page.tsx` (515 lines)

Extract into: `PixelsList`, `AddPixelForm`, `PixelTestTool`. Namespace: `marketingPixels.*`.

### Task 19 — `stores/[id]/pages/page.tsx` + remaining pages (≤500 lines each)

Batch the tail in one commit: `shipping`, `payment-settings`, `features`, `products/[productId]/edit`, `products/[productId]/recommendations`, `products/[productId]/variants`. Each gets string-wrapping + RTL sweep but only minor extraction if any single section exceeds ~150 lines.

### Task 20 — Shell pages: login, users, audit-logs, root layout/providers

Small pages — one commit per concern group. Namespace: `auth.*`, `users.*`, `audit.*`, `common.*`.

---

## Task 21 — Sweep for stragglers

**Files:**

- Script: `apps/admin/scripts/find-hardcoded-strings.sh` (temporary, not committed)

- [ ] **Step 1: Grep for English literals still present in admin JSX**

```bash
# Find >5 char capitalized English strings that look like UI copy, excluding
# imports, types, and anything already inside t() or aria-labels using t().
grep -rE '>[A-Z][a-z][a-zA-Z ]{4,}<' apps/admin/src/app apps/admin/src/components \
  | grep -v 'node_modules' \
  | grep -v 't(' \
  | head -50
```

- [ ] **Step 2: Fix each hit** — wrap with `t()` and add key to both JSONs.

- [ ] **Step 3: Run build + typecheck**

```bash
npm run build --workspace apps/admin
# expect: 0 errors, 0 warnings
```

- [ ] **Step 4: Commit** — `chore(admin/i18n): wrap remaining stragglers`.

---

## Task 22 — Translator handoff package

**Files:**

- Create: `docs/superpowers/i18n/admin-strings-for-translator.json` (export of `en.json`)
- Create: `docs/superpowers/i18n/glossary.md` (commerce terminology)

- [ ] **Step 1: Export keys + source text**

```bash
cp apps/admin/src/i18n/messages/en.json docs/superpowers/i18n/admin-strings-for-translator.json
```

- [ ] **Step 2: Write a glossary**

Table of ~30 commerce terms with preferred Arabic rendering:
| English | Arabic | Notes |
|---|---|---|
| SKU | SKU | Keep Latin (global standard) |
| Coupon | كوبون | |
| Abandoned Cart | عربة متروكة | |
| COD | الدفع عند الاستلام | Expand on first use |
| Loyalty Tier | مستوى الولاء | |
| Variant | متغير | |
| Payout | دفعة | |
| Fulfillment | التجهيز | |
| etc. | | |

- [ ] **Step 3: Send handoff package + commit the glossary**

```bash
git add docs/superpowers/i18n
git commit -m "docs(i18n): admin string export + arabic glossary"
```

Acceptance: translator returns a populated `ar.json` with matching key structure; we drop it in + verify every page in AR mode.

---

## Verification Checklist (run after every 3 tasks, hard-gate before merge)

- [ ] `npx tsc --noEmit` clean in `apps/admin`
- [ ] `npx eslint src` clean in `apps/admin`
- [ ] `npm run build --workspace apps/admin` succeeds
- [ ] Every touched page.tsx ≤ 400 lines
- [ ] Every touched page renders in EN at :3001 with no visual regression
- [ ] Every touched page renders in AR with `admin-lang=ar` cookie: layout mirrors, no horizontal scroll, form controls keep 44×44 targets
- [ ] `grep -rE '>[A-Z][a-z][a-zA-Z ]{4,}<' apps/admin/src/app/<page>` on each touched page returns 0 hits
- [ ] No directional `ml-*`/`mr-*`/`left-*`/`right-*` remain in touched files (confirm via `grep`)

---

## Self-Review Notes

**Spec coverage:** Every page > 500 lines gets an explicit task; smaller pages get batched into Task 19/20. Every admin `.tsx` visible string gets wrapped via Tasks 1–21.

**Type consistency:** All extracted components follow the `_components/<PascalName>.tsx` + `_hooks/use<Name>.ts` convention. The `useT` helper has one signature. Namespace keys use lowercase dotted paths consistently.

**Known risks:**

- **next-intl key mismatch** — a missing key shows `Error: MISSING_MESSAGE`, which crashes the page in dev. Always add the key to both JSONs before wrapping the string. Run the build between tasks.
- **RTL script false positives** — the perl command can match CSS animation names (`left-side`) or JS variable names; review the diff before commit. Revert false positives manually.
- **Arabic placeholder in production** — users in AR mode see English until translator delivers. Gate the `ع` switch visibility behind a feature flag if that's unacceptable, or ship behind `NEXT_PUBLIC_ADMIN_I18N_AR=true` env var with a visible "beta" tag on the switcher.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-04-23-admin-i18n-and-extractions-plan.md`. Two execution options:

1. **Subagent-driven (recommended)** — I dispatch a fresh subagent per task (22 tasks, one commit each), review between tasks. Fast iteration, isolated context.
2. **Inline execution** — I execute tasks 1–22 in this session with a checkpoint every 3 tasks.

Pick one to start. Estimated wall time: 6–8 hours subagent-driven, 10–12 hours inline.
