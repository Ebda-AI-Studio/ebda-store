# SEARCH-T6-1

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T6-1 — search insights are aggregated, k>=2 and carry no shopper data, so staff holding `analytics:read` may view the Searches page and the Analytics card (route chain: authenticate, requireMfaEnrolled, requirePermission('analytics:read'), requireStoreAccess, as the `/analytics` siblings). Cost if wrong: a staff member sees terms searched twice or more by shoppers of their own store.
