# SEARCH-T3-3

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T3-3 — `meta.truncated` is returned by the admin product list (and shown as the "capped results" line there and on the warehouse stock page); `listPublic` stays silent at 1,000 because the storefront keyword leg belongs to Task 12 (E10). `advancedSearch` carries no flag (see SEARCH-T3-6). Evidence: every flag needs a viewer (every-data-needs-UI); the admin list and warehouse page are the viewers. Cost if wrong: a storefront search matching more than 1,000 products under-reports `total` until Task 12.
