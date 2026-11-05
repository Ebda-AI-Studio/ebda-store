# PREMIUM-23

> Section: 2026-11-03 - Storefront premium defaults (PREMIUM-\*)

Ruling PREMIUM-23 - the blog index is server-rendered. `/blog` and its tenant-tree twin fetch `/public/:storeId/blog` on the server (`BlogIndexBody`, 60s revalidate) and hand the list to a client leaf with no fetch and no loading state; blog-off (404) is a rendered state, a 5xx throws so it is not cached as an empty list. Post pages were already server-rendered with Article JSON-LD. Evidence: `blog-index-ssr.test.tsx`. Cost if wrong: a publish shows on the list up to 60 seconds late.
