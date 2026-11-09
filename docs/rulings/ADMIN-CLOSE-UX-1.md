# ADMIN-CLOSE-UX-1

> Section: Admin audit closure 2026-11-09, UX track (branch `fix/admin-audit-closure`)

Ruling ADMIN-CLOSE-UX-1 - UX:PE-2 stays open: the variants and recommendations pages are not folded into the product edit page. Both pages (`products/[productId]/variants`, `.../recommendations`) own their own Save and data loading, and the edit page is already 1400+ lines with one StickySaveBar; folding them means moving two stateful forms under that bar and re-pointing the links at edit:784-788,852, which is a refactor, not a closure fix. The names stay linked from the edit page, so nothing is lost. Cost if wrong: a merchant editing a product still leaves the edit page to set variants or recommendations and saves them separately.
