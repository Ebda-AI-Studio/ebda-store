# Admin fix pass, T3 UI foundation (2026-11-04)

Foundation commit

- New shared components: `PageHeader`, `StickySaveBar`, `FormFooter`, `RowActions`, `PageState`, `ArrowStart`/`ArrowEnd`, and `useConfirm()` with the `ConfirmHost` mounted in `AdminLayout`. Standard: `docs/admin/ACTION-PLACEMENT-STANDARD.md`.
- `ERROR_AR` / `ERROR_EN` applied inside `apiRequest` and `apiGetPage` by `error.code` (and status class): English server text no longer reaches the Arabic admin; `details.messageAr` still wins. Dead `getErrorMessage` removed.
- `PLAN_LABELS_AR` / `planLabel()` derived from the locked public plan catalogue.
- `--bottom-chrome` CSS variable (mobile bottom nav + safe area) for sticky bars.
- Hubs: coupons, promotions, loyalty, bundles, wallet move from Sales to the Marketing hub ("التسويق والعروض", lands on coupons); Sales gets a customers divider group; categories, tags, bulk join Catalog; delivery and staff join Settings.
- `scripts/merge-i18n-fragments.mjs` (+ `--check`) merges `apps/admin/src/i18n/fragments/<track>.<locale>.json` into ar.json/en.json. Idempotent, fragment keys win, two fragments owning one key fails.
- Guards: `admin-action-placement` ratchet, `hubs.test.ts`, `api-error-map.test.ts`, `use-confirm.test.tsx`, `merge-i18n-fragments.test.ts`; `admin-i18n-keys-resolve` also resolves fragment keys.

Rulings

- Ruling T3-1 - Notifications stays in the Marketing hub, not Settings. The page is staff-accessible (order alerts) and the Settings hub is owner-only (`settings-registry.test.ts` pins it). Cost if wrong: the Settings hub has no tab for it; a settings-page card links to it instead.
