# QA-BATCH-B-1

Ruling QA-BATCH-B-1 - merchant-admin QA batch B (2026-11-11, Amelia Aurum), item by item.
B1: the product edit page queues its success message (`lib/flash-toast.ts`) and `FlashToast` shows it once the list has rendered, so «اتحفظ المنتج» no longer depends on a toast surviving the route change.
B2: one rule, `apps/api/src/lib/storefront-categories.ts#visibleToShoppers`, hides a category with no shopper-visible product (an empty parent stays when a child has products); it feeds `/public/categories` (nav, home, /categories, sitemap, llms.txt), the filter options and search suggestions. The merchant's own category list is not filtered, and a direct URL to an empty category still resolves.
B3: the edit page's English name field is labelled «اسم المنتج (بالإنجليزية)» / "Product Name (English)", the pair of the Arabic one.
B4: admin controls use SVG icons (`SparkleIcon`, `BalanceIcon`, a camera glyph), never emoji; `tests/unit/admin-no-emoji-in-controls.test.ts` fails on a real emoji in admin code or messages (plain marks such as ✓ ✕ are legal; three decorative status maps are allow-listed and may only shrink). The «⚠» prefix is gone from retry labels.
B5: the FAQ section toggle and the image-remove icon button now render through the ADM-BTN-1 `Button` (lg ghost, icon-sm). The mobile tab-bar «المزيد» stays 56 px on purpose: it is a tab (`data-ui="nav"`, ADM-BTN-1 exempts tabs) and must match its sibling tabs' height; it is not a button look.
B6: the edit page title uses the Arabic name on the Arabic UI (English first on the English UI), falling back to the other language.
B7: see SLUG-LOCALE-1 (ruled, not changed).
B8: «احفظ القواعد» is now «احفظ قواعد الجملة» with a line under it saying it saves on its own and the rest of the product is saved with «احفظ المنتج».
Cost if wrong: B2 hides a category a merchant wanted shoppers to see before it has products (fix: add a product, or a per-category show-when-empty flag); B5's 56 px tab could be judged a stray after all (fix: shrink the bar for every tab together).
