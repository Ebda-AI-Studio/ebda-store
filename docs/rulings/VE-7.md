# VE-7

> Section: 2026-10-22 — Visual editor (VE-\*)

Ruling VE-7 (Task 6, 2026-10-22) — P-05 (colour scheme, density, text scale) is NOT a per-section setting, so it does not land in Task 6. The plan's table said "section settings"; the page builder shows `SchemeSelect`, `DensitySelect` and `TextScaleSelect` only inside the page-type cards (`pg.colorScheme`, `pg.density`, `pg.textScale` of products, product detail, categories, locations, checkout, cart), which are `siteSettings` pages. They move with the page settings in Task 8e. Evidence: `page-builder/page.tsx` call sites at the page cards; no section card uses them. Cost if wrong: a merchant looking for a per-section text scale finds none until 8e, which is also where the storefront reads it.
