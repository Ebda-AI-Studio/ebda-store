# R-EBDA-3D-8

> Section: 2026-10-07 — Product 3D models + AR (R-EBDA-3D-\*)

Ruling R-EBDA-3D-8 — "all templates' product pages + quick view": there is ONE PDP render path (`ProductDetailClient`, both routing trees, all 5 templates; the builder has no product-detail section) and NO quick view exists in `apps/web`. The viewer ships in that one path; quick view is Phase 2 and starts by building quick view. The "3D" chip on product cards (8 card render paths) is also Phase 2. Evidence: `grep -ri quickview apps/web/src` is empty; templates own no product page. Cost if wrong: none for templates; a later quick view must embed the viewer itself.
