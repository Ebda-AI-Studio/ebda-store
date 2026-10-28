# EWO-F2

> Section: Cluster F — agent discovery, llms.txt, SEO, i18n

**Ruling EWO-F2 — #2224: a per-store llms.txt AUTO-BUILD answers 503 (`Retry-After: 60`,
`no-store`) when categories OR products could not be asked; `fetchProducts` now returns `null` for
"could not ask" (any page failing, including a later one).** A body that enumerates "0 categories"
/ "0 products" / a silently short list is a false statement to every crawler; a 503 is retried and
caches nothing. The stored-override branch has no enumerations of its own and keeps serving (short
`s-maxage=60` when categories were not fetched). The same collapse was fixed in
`/feeds/products.json` (every upstream failure used to answer a cacheable `404 Not found`; now
404 only on the API's own 404, else 503 no-store). acp.json/ucp enumerate nothing. Cost if wrong:
during an API blip an auto-built llms.txt is unavailable for ~60s rather than served degraded.
