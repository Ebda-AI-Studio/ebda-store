# Regression report (feat/storefront-templates vs origin/main)

## 1. admin-tint-ink-contrast
Failure: 2 offenders, both `apps/admin/src/app/stores/[id]/template/page.tsx` line 155
`<p role="alert" className="text-sm text-destructive">` : bare text-destructive on the card = 4.38:1 light, 3.63:1 dark.
Cause: new template page used the raw role colour for message text; the repo rule is the `-ink` token.
Fix: `text-destructive` -> `text-destructive-ink`. Test not weakened, no exclusions.

## 2. dahab-template-render snapshot
Diff (token-level, 6 occurrences across en+ar): 
- `<div class="relative aspect-[4/5] w-full">` -> `+ <div class="relative w-full aspect-[4/5]">` (and the `opacity-60` variant).
Cause: (a) R1 violation. `apps/web/src/templates/dahab/ProductCard.tsx` rebuilt the legacy class string as
`cx('relative w-full', lookImageAspectClass(look) || 'aspect-[4/5]')`, reordering classes for no-look stores (fixture has no look).
Fix: when no look aspect applies, emit the original literal `'relative aspect-[4/5] w-full'`; look path keeps `relative w-full <aspect>`.
Snapshot NOT updated. Other templates' fallbacks were checked against origin/main: legacy strings unchanged.

## Verification
- npm run build -w packages/shared; vitest on admin-tint-ink-contrast, dahab-template-render, builder-homepage-characterization, 
  all tests/unit/looks-*, apps/web/src/templates/shared/looks-*.test.tsx: 12 files, 271 tests passed.
- tsc --noEmit apps/web: clean; apps/admin: clean. `npm run lint`: 0 errors (29 pre-existing warnings).
