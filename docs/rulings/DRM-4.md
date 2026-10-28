# DRM-4

> Section: Backlog batch d-routes-mcp (2026-10-01)

**Ruling DRM-4 — a change to a cached payload's SHAPE bumps its cache key in the same commit (PR 2301
audit).** The public bundle list (`public:bundles:v2:`), the bundle detail
(`public:products:<id>:bundles:v2:<slug>`, still under the product prefix every invalidator
clears) and the customers aggregation (`customers-agg:v3:`) all changed shape in this batch, and an
old-shape entry read by the new reader would blank the bundles page or drop the export's
truncation notices until the TTL ran out. `withinSaleWindow` also treats an absent bound as
unbounded (`== null`). The Next data cache and the CF edge hold API RESPONSES, whose shape is
unchanged, so they need no bump. Cost if wrong: one cache miss per store at deploy.
