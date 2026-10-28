# SEARCH-T3-6

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T3-6 — the super-admin `GET /admin/products` caps its search at the closest 1,000 matches per store without a `truncated` flag, and `advancedSearch` (`/stores/:storeId/products/search`) dropped its flag, because no admin UI consumes either route (grep of `apps/admin` and `apps/orders`), so a flag would be data with no viewer. The cap is documented at the call site. Cost if wrong: an API client of either route sees a silently capped total past 1,000 matches.
