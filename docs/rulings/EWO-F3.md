# EWO-F3

> Section: Cluster F — agent discovery, llms.txt, SEO, i18n

**Ruling EWO-F3 — #2127: the sitemap THROWS (route 5xx) when its source could not be asked —
store-list page 1, a thrown store-list fetch, a non-404 custom-domain host resolve, and a
custom-domain products page 1.** A 200 empty `<urlset/>` overwrote GSC's last-good state; the host
resolve failure used to fall through to the PLATFORM sitemap on a merchant's own domain. A
master-sitemap store whose own fan-out fails still degrades to static pages (logged, existing
behaviour, O2-1). Cost if wrong: a persistent API outage leaves GSC on a stale-but-valid sitemap
instead of an empty one — the intended trade.
