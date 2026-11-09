# Admin audit closure 2026-11-09, phase 2: StoreDO settings patch

- BE:F-2 / BE:F-3: new StoreDO op `patchSettings` (`patchStoreSettings` in `packages/repo/src/rpc/settings.ts`, `storePatchOnDo` in `apps/api/src/lib/repo-factory.ts`). It merges ONLY the sent top-level keys of `settings` / `theme` / `socialLinks` against the value the DO holds, and writes the plain columns in the same DO transaction. `StoreService.update` (settings), the per-key setters (`updateFloatingWidget`, `setMcpWriteEnabled`, `setGoldAllowDeferredPayment`, QR / labels) and `updateBrandingBundle` use it on a DO store, so two quick saves of different keys both survive and a refused bundle part writes nothing. Server-owned settings keys are still stripped on the generic route.
- `PUT /stores/:id/branding-bundle` social part is now a key patch (`{ set, remove }`), applied inside the DO on a DO store.
- Ruling `CLOSURE-F2F3` deleted (rulings 1694 -> 1693); FP-5 and FP-8 note they are superseded for DO stores.
- Tests: `packages/repo/test/rpc-settings-patch.test.ts`, `tests/unit/store-settings-patch-on-do.test.ts`.
- Residual: `updateTheme` and the `PUT /:id/social` route on a DO store still read-merge-write their own column (separate surfaces, not the settings/bundle path).
