# ICEBERG-EDGE-308-1

> Section: Iceberg quick wins (2026-11-10)

**Ruling ICEBERG-EDGE-308-1 - the edge's permanent 308 to a store's default language is `private, max-age=300` + `Vary: Cookie`; the cookie-driven 307 stays `private, no-store`; overrides the never-cached part of LOCALE-REDIRECT-EDGE-1.** Measured 2026-11-10 on storedemo-souq.ebda.app/: the edge redirect from #497 is live (empty body, Location /ar) but costs 0.65-2.2 s ttfb per visit. Private keeps it out of shared caches; the remaining cold-render cost is PR #523's. Cost if wrong: after a merchant switches the default language, a browser that visited in the last 5 minutes still lands on the old language once.
