# BS-1

> Section: 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-1 — issues 2247 / 2269: the all-time customer count keeps its full scan, but on its
own 900s cache key; no expression index or persisted `customer_key` column is added.** The count
has no UI consumer today (`allTimeCustomers` is read by the MCP `admin_get_analytics` payload and
the integration parity test only), and it was the one unbounded scan. It now runs at most once per
store per 15 minutes instead of once per distinct date range per 120s, and the default window's
cache key is quantised to the minute so a range-less caller finally hits the 120s cache. An
expression index cannot give an index-only scan for `COUNT(DISTINCT <expr>)`, and a persisted key
column would have to be maintained on every order write path (create, guest claim, address edit).
The windowed counts keep using `@@index([storeId, createdAt])`. Cost if wrong: on a store with tens
of thousands of orders one dashboard request per 15 minutes pays a full orders scan, and the MCP
all-time figure lags a new customer by up to 15 minutes.
