# SEARCH-T5-8

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T5-8 — Cloudflare Workers Logs (invocation logs on api/admin/orders) store full request URLs, so a phone typed into `?search=` can sit there for the platform's log retention; code cannot scrub it. Accepted and documented in `docs/privacy/data-map.md` and `docs/RETENTION.md` (retention window, readable by Ebda operators only), not turned off, because these are our only production request trace pre-launch. Revisit before launch: move the storefront-to-API search term out of the URL (POST body or header) so it never enters invocation logs. Cost if wrong: a shopper's typed phone number retained in operator-only logs for the retention window. Extended by SEARCH-P2-9: the admin and Orders-PWA search calls (⌘K, customers, orders) no longer carry the term in the URL; the storefront → API term is still open.
