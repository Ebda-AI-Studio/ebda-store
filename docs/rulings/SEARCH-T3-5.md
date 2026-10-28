# SEARCH-T3-5

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T3-5 — coupon search (`coupon.service.ts`, code/name), super-admin store search (`provisioning.service.ts`, store name/slug/domain) and purchase-order supplier search (`accounting/purchase-order.service.ts`) stay unfolded `contains` for now and are listed for a follow-up task. Evidence: different domains; customers and orders are Tasks 15-17. Cost if wrong: an Arabic spelling variant misses a coupon, store or supplier in those three admin searches until the follow-up.
