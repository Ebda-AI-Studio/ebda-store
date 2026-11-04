# Admin fix pass, T3 UI foundation (2026-11-04)

Foundation commit

- New shared components: `PageHeader`, `StickySaveBar`, `FormFooter`, `RowActions`, `PageState`, `ArrowStart`/`ArrowEnd`, and `useConfirm()` with the `ConfirmHost` mounted in `AdminLayout`. Standard: `docs/admin/ACTION-PLACEMENT-STANDARD.md`.
- `ERROR_AR` / `ERROR_EN` applied inside `apiRequest` and `apiGetPage` by `error.code` (and status class): English server text no longer reaches the Arabic admin; `details.messageAr` still wins. Dead `getErrorMessage` removed.
- `PLAN_LABELS_AR` / `planLabel()` derived from the locked public plan catalogue.
- `--bottom-chrome` CSS variable (mobile bottom nav + safe area) for sticky bars.
- Hubs: coupons, promotions, loyalty, bundles, wallet move from Sales to the Marketing hub ("التسويق والعروض", lands on coupons); Sales gets a customers divider group; categories, tags, bulk join Catalog; delivery and staff join Settings.
- `scripts/merge-i18n-fragments.mjs` (+ `--check`) merges `apps/admin/src/i18n/fragments/<track>.<locale>.json` into ar.json/en.json. Idempotent, fragment keys win, two fragments owning one key fails.
- Guards: `admin-action-placement` ratchet, `hubs.test.ts`, `api-error-map.test.ts`, `use-confirm.test.tsx`, `merge-i18n-fragments.test.ts`; `admin-i18n-keys-resolve` also resolves fragment keys.

Second commit

- Dashboard: header primary is "افتح المحرر"; new "محتاج تصرّف" row (orders, low stock, returns, reviews from existing endpoints); stats error tile with retry; quick actions are real jobs (add product, phone order, coupon, copy store link); Suspend / Activate moved into the super-admin DangerZone; "edit store" moved into the details card.
- Settings hub: five groups (`lib/settings-groups.ts`), developers collapsed, no "back to store" in the header; `SettingsRail` on every settings page; TopBar `parent` breadcrumb ("الإعدادات"); plain-Egyptian card text; "شكل المتجر" is the one door to the editor.
- `--warning` is now a muted brass (no amber); amber classes in shared components use the warning tokens; emoji icons replaced by `SparkleIcon`; sub-12px text lifted to `text-xs` in shared components.
- Plan copy: "باقة" only in the upgrade gate; plan names come from `PLAN_LABELS_AR`.
- `AccountsError` messages go through the same error map (auth screens).
- New ratchets: `admin-copy-ratchets` (register, English feedback literals, 12px floor).

Rulings

- Ruling T3-1 - Notifications stays in the Marketing hub, not Settings. The page is staff-accessible (order alerts) and the Settings hub is owner-only (`settings-registry.test.ts` pins it). Cost if wrong: the Settings hub has no tab for it; a settings-page card links to it instead.
- Ruling T3-2 - Not done in T3, left to the owner track with a reason: native `confirm()/alert()` swaps (32 files, list in `admin-action-placement-known-debt.json`), `backToSettings|backToStore` removal in 16 pages, plan names hard-coded in page namespaces (`customerGroups.page.planRequired`, `wholesale.pricing.upgrade`, `paymentAbandonments.page.enterprise`, `finance.fxRates.featureInactiveDesc`) because each needs a `{plan}` placeholder wired in the owning page. Cost if wrong: those pages keep the old copy until their track lands.
