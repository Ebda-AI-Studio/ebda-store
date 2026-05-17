# Mobile UI ship — match Pecannbee + Bank-Alkahraman sizing

**Date:** 2026-05-16
**Scope:** platform-wide (all stores inherit) — shared storefront components in `apps/web`
**Reference:** hybrid — pecannbee.com.kw structure + bank-alkahraman.com RTL polish
**Status:** plan-pending-approval — no code touched yet

---

## Target measurements (from 16 mobile screenshots, iPhone Pro Max @ 3x, viewport ~440×956)

| Surface            | Element                    | Source px (W×H)       | CSS px (W×H) | Aspect ratio                |
| ------------------ | -------------------------- | --------------------- | ------------ | --------------------------- |
| **Home**           | Hero banner                | 1320×880 (pecannbee)  | 440×293      | **3 : 2** landscape         |
|                    | Hero banner                | 1290×740 (alkahraman) | 430×247      | **~16 : 9** landscape       |
|                    | Category tile (image area) | 580×580               | 193×193      | **1 : 1 square**            |
|                    | Category tile (with label) | 580×660               | 193×220      | 1 : 1.14                    |
|                    | Product carousel card      | 530×730               | 177×243      | ~3 : 4 portrait             |
| **Category page**  | Product card (image)       | 580×500               | 193×167      | **~7 : 6** slight-landscape |
|                    | Product card (full)        | 580×760               | 193×253      | ~3 : 4 portrait overall     |
| **Product detail** | Main product image         | 1180×1180             | 393×393      | **1 : 1 square**            |
| **Shared**         | Bottom nav                 | 1320×160              | 440×53       | —                           |
|                    | Header logo height         | 120                   | 40           | —                           |
|                    | Search bar                 | 1240×120              | 413×40       | rounded pill                |

Caveat: these are visual estimates from screenshots, accurate to ±5%. Pixel-perfect would require a color-sampling tool, but tail-end precision matters less than getting the right ratios.

---

## Delta vs current FWB (`apps/web/src/templates/`)

| Component                                   | Current                                          | Target                                                                   | Action                                                    |
| ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `templates/shared/HeroBanner.tsx`           | `aspect-[3/4]` mobile / `aspect-[2.4/1]` desktop | `aspect-[3/2]` mobile / `aspect-[2.4/1]` desktop keep                    | **change mobile from portrait to landscape 3:2**          |
| `templates/modern/CategoryCard.tsx`         | `aspect-[4/3]`                                   | `aspect-square`                                                          | **change to 1:1 square**                                  |
| `templates/elegant/CategoryCard.tsx`        | ? (TBD on read)                                  | `aspect-square`                                                          | inspect + align if different                              |
| `templates/classic/CategoryCard.tsx`        | ?                                                | `aspect-square`                                                          | inspect + align if different                              |
| `templates/minimal/CategoryCard.tsx`        | ?                                                | `aspect-square`                                                          | inspect + align if different                              |
| `templates/bold/CategoryCard.tsx`           | ?                                                | `aspect-square`                                                          | inspect + align if different                              |
| `templates/modern/ProductCard.tsx`          | `aspect-[3/4]`                                   | `aspect-square` for category grid, keep `aspect-[3/4]` for home carousel | **dual mode: square in 2-col grid, portrait in carousel** |
| `templates/shared/PecannbeeProductCard.tsx` | `aspect-square` already ✓                        | —                                                                        | **already correct — use this for category grids**         |
| Footer (all 5 themes)                       | No "Powered by" line                             | "Powered by Force AI"                                                    | **add line + i18n key already exists**                    |
| Product detail page image                   | unknown ratio                                    | `aspect-square`                                                          | inspect + align                                           |
| Bottom nav                                  | exists                                           | exists, may need height tweak                                            | inspect height                                            |

### Files that need explicit reading before touching

| File                                                       | Why                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `templates/elegant/CategoryCard.tsx`                       | confirm current aspect ratio                                                        |
| `templates/classic/CategoryCard.tsx`                       | confirm current aspect ratio                                                        |
| `templates/minimal/CategoryCard.tsx`                       | confirm current aspect ratio                                                        |
| `templates/bold/CategoryCard.tsx`                          | confirm current aspect ratio                                                        |
| `templates/modern/CategoryCard.tsx`                        | confirmed `aspect-[4/3]`                                                            |
| `apps/web/src/app/products/[slug]/ProductDetailClient.tsx` | confirm product-detail image aspect                                                 |
| Footer components × 5 themes                               | confirm where to inject "Powered by Force AI"                                       |
| `contexts/LanguageContext.tsx:214`                         | extend existing i18n entry from "Powered by Force" → "Powered by Force AI" + Arabic |

---

## Interactive controls (catalog from target screenshots)

| Control                                                    | Both targets show | Currently in FWB?                       |
| ---------------------------------------------------------- | ----------------- | --------------------------------------- |
| Header: hamburger (left) + centered logo + cart (right)    | ✓                 | likely ✓ — verify                       |
| Header: filter funnel icon on category page (right)        | pecannbee         | unknown — may need add                  |
| Search bar full-width below header                         | ✓                 | likely ✓                                |
| Hero with dot pagination (3 dots if carousel)              | pecannbee         | ✓ via `HeroSlider.tsx`                  |
| Tab pills (Tea & Herbs / Dates) on category landing        | pecannbee         | unknown — may need add                  |
| Category tile (tap-only, no overlaid CTA)                  | ✓                 | likely ✓                                |
| Product card on home: heart top-right + "View" pill button | pecannbee         | partial — `PecannbeeProductCard` has it |
| Product card "Out Of Stock" red banner top-left            | pecannbee         | unknown — may need add                  |
| Product card in category grid: View + Add To Cart pills    | pecannbee         | partial                                 |
| Round `+` add-to-cart button                               | bank-alkahraman   | may want as alt variant                 |
| Sort dropdown ("New Arrival ▼") on category page           | pecannbee         | likely ✓ — verify                       |
| Product detail: image carousel left/right chevrons         | pecannbee         | likely ✓                                |
| Share icons row (X / FB / Telegram / WhatsApp)             | pecannbee         | likely ✓                                |
| Bottom nav (4 icons + elevated center cart)                | both              | likely ✓                                |
| Floating chat bubble bottom-right                          | pecannbee         | already present (storefront has chat)   |

---

## Ranked implementation plan (ship-today order)

### Tier 1 — visible-on-load impact, < 1h total

1. **HeroBanner mobile aspect** — `aspect-[3/4]` → `aspect-[3/2]` (or `aspect-[2/1]` if 16:9 chosen). 1 line.
2. **CategoryCard mobile aspect** in modern theme — `aspect-[4/3]` → `aspect-square`. 1 line.
3. **Footer "Powered by Force AI"** — extend i18n string + render in all 5 theme footers. Single import per theme. ~30 min total.

### Tier 2 — visible-after-scroll, < 1h

4. **Category grid uses square cards across all themes** — confirm + align elegant/classic/minimal/bold to 1:1.
5. **Product card in category grid**: switch from `aspect-[3/4]` to `aspect-square` (or `aspect-[7/6]` if exact pecannbee). Need to differentiate from carousel use.
6. **Product detail image aspect** — confirm + lock to 1:1 square.

### Tier 3 — polish + bonus, < 1h

7. **Filter funnel icon** in category page header (if not already there).
8. **Tab pills** on category landing pages (if Ahmad wants the category-of-categories pattern).
9. **"Out Of Stock" red banner** on product card top-left if not there.

### Tier 4 — not today (defer)

- Round `+` add-to-cart button variant
- Theme-level configuration so merchant can opt-in
- Per-theme RTL refinements beyond what's already shipped

---

## Implementation order (file-by-file)

Each step = its own commit so rollback is granular. All commits use the existing `feat(web)` / `fix(web)` scope per commitlint.

1. **commit: `fix(web): hero banner mobile landscape (3:2) match target sizing`**
   - file: `apps/web/src/templates/shared/HeroBanner.tsx` line 45
   - change: `aspect-[3/4]` → `aspect-[3/2]`

2. **commit: `fix(web): category cards square (1:1) across all themes`**
   - files: `templates/{modern,elegant,classic,minimal,bold}/CategoryCard.tsx`
   - change: any `aspect-[4/3]` or other → `aspect-square`

3. **commit: `fix(web): product card square in category grid, portrait in carousel`**
   - files: `templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx`
   - approach: add an optional prop `variant: 'grid' | 'carousel'` defaulting to `'grid'` → use `aspect-square` for grid, `aspect-[3/4]` for carousel
   - update call sites in `ProductGrid.tsx` (default grid) and home/carousel (`variant="carousel"`)

4. **commit: `fix(web): product detail main image square (1:1)`**
   - file: `apps/web/src/app/products/[slug]/ProductDetailClient.tsx`
   - confirm current + align if needed

5. **commit: `feat(web): footer "Powered by Force AI" across all themes`**
   - file 1: `contexts/LanguageContext.tsx:214` — change `'Powered by Force': 'مدعوم من Force'` → `'Powered by Force AI': 'مدعوم من Force AI'`
   - files 2-6: `templates/{modern,elegant,classic,minimal,bold}/Footer.tsx` — add `<p>{t('Powered by Force AI', 'مدعوم من Force AI')}</p>` at the very bottom
   - alt: extract a `<PoweredByForce />` shared component to avoid 5× copy-paste

6. **commit: `fix(web): mobile hero accidental empty crop on iOS Safari (if found during smoke)`**
   - placeholder for any other regression we surface during the deploy

---

## Risks + mitigations

| Risk                                                                               | Mitigation                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changing hero aspect on existing stores crops merchant hero images badly           | Force `object-cover` is already in place; image will crop center. Acceptable for the change. If a specific merchant complains, can add a per-store `heroAspect` override later. |
| Square category tiles on stores with very-tall category images crop heads/products | `object-cover` again. Pecannbee tile design has subject centered, so most images work.                                                                                          |
| `PecannbeeProductCard` already exists but isn't used everywhere                    | Plan keeps existing ProductCards per theme — just changes aspect ratio. Migration to `PecannbeeProductCard` as the universal card is out of scope today.                        |
| "Powered by Force AI" reads as advertising on premium-positioned stores            | Per-store toggle later if anyone objects. Default-on aligns with platform branding.                                                                                             |
| RTL alignment after aspect changes                                                 | `start-*` / `end-*` Tailwind classes already used per `feedback-tailwind-v4-css-vars.md`. No new RTL work needed.                                                               |
| Themes other than modern have different sizing                                     | Tier 2 step 4 explicitly aligns all five. Spot-check after each commit.                                                                                                         |

---

## Rollback path

- Every change is one commit, granular.
- `bash scripts/rollback.sh` reverts the last commit + auto-redeploys Vercel + Railway in ~2 min.
- For a multi-commit rollback (e.g. tier 1 fine but tier 2 breaks a theme), `git revert <sha>..<sha>` and push.
- Vercel's "Promote to Production" on a previous deployment is a 30-sec instant rollback if Sentry shows storefront errors after deploy.

---

## What I'll do next (after Ahmad approves this plan)

1. Read the 5 CategoryCard files + ProductCard files + Footer files to confirm exact lines to change.
2. Execute commits 1-5 in order. Run `npm run typecheck` after each.
3. After commit 5, browse-qa the storefront on mobile dimensions (Chrome devtools 375×812 + 414×896) to confirm:
   - Hero is landscape
   - Category tiles are square
   - Product cards in grid are square
   - Product detail image is square
   - Footer shows "Powered by Force AI" in EN + Arabic
4. Push. Watch Vercel rebuild (~2 min). Smoke-test wadyaljuz.com on mobile.
5. Report back with screenshots.

Estimated total: **~2-3 hours of focused work** including verification. Ship-today target is realistic.

---

## Decisions (2026-05-16, Ahmad confirmed)

1. ✅ **Hero mobile aspect = 3:2** (pecannbee style)
2. ✅ **Tab pills on category landing = INCLUDE today** (adds ~1h component work)
3. ✅ **Product card CTA = dual** ("View" for browse-only, "Add to Cart" for in-stock)
4. ✅ **Out-of-stock visual = top-left red ribbon** (pecannbee pattern)

Revised total estimate: **4-5 hours focused work** to ship all of the above today.

## End-to-end admin sync (added 2026-05-16 mid-plan)

Every storefront sizing change MUST be reflected in the admin upload UI so merchants see what their storefront will actually look like. Otherwise: merchant uploads portrait hero → cropped to landscape on storefront → blames the platform.

### Admin changes (Commit 6)

| Admin surface                                                                                                    | Current state                          | Required change                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/admin/src/components/ImageUpload.tsx`                                                                      | generic uploader, no aspect constraint | add `aspectRatio?: '3/2' \| '1/1' \| 'free'` prop; render preview at locked aspect            |
| `apps/admin/src/app/stores/[id]/hero/page.tsx` line 261                                                          | `<ImageUpload>` no aspect              | pass `aspectRatio="3/2"`; update `heroImageHint` to "Recommended: 1200×800px (3:2 landscape)" |
| `apps/admin/src/app/stores/[id]/categories/CategoryForm.tsx`                                                     | (TBD on read)                          | pass `aspectRatio="1/1"`; update hint to "Recommended: 800×800px (1:1 square)"                |
| `apps/admin/src/app/stores/[id]/products/[productId]/_components/ProductInfoSections.tsx` + `MultiImageGrid.tsx` | already `aspect-square` ✓              | hint update only: "Recommended: 1000×1000px (1:1 square)"                                     |
| i18n: `hero.page.heroImageHint`, `categories.imageHint`, `products.imageHint`                                    | exist                                  | update text strings (EN + AR)                                                                 |

### Validation note

This isn't enforcing — merchants can still upload any-aspect image. The preview shows the cropped result so they can re-shoot/re-crop before saving. Hard validation would block existing merchants whose images don't match — bad trade. Soft preview-driven nudging is the right balance.
