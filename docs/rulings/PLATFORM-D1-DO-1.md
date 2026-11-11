# PLATFORM-D1-DO-1

> Section: 2026-11-11 plans-vs-main audit, M-141 and M-150

Ruling M-141 - the platform D1 stays ONE database for every tenant (directory, billing, webhook bodies) for now; per-store data is already sharded per Durable Object, so D1 holds only platform rows. Trigger to shard: D1 size above 5 GB (hard cap 10 GB) or p95 of a platform query above 100 ms for a week; until then a size alarm is the control, not a re-architecture. Evidence: platform families moved to D1 in dff49c959; store data sharded separately (cff798cf1). Cost if wrong: a hot tenant's webhook bodies could crowd platform reads, and a D1 at the cap fails writes for all tenants at once; mitigation is a retention sweep on webhook bodies plus the size alarm.

Ruling M-150 - NO DO `jurisdiction` (it is baked into the object id, so adding it later would orphan every existing store DO and lose its data). A per-namespace `locationHint` is allowed for NEW objects only and is deferred: Egypt merchants are served from the nearest Cloudflare location by default, and a hint only affects first placement. The privacy text must stay accurate: it says Cloudflare runs a global network and does not promise Egyptian or EU residency; PDPL residency claims are NOT made. Evidence: apps/marketing/src/lib/legal-privacy-stack.ts:18 states "global network"; no jurisdiction/locationHint in code (grep apps packages). Cost if wrong: a customer or regulator demanding in-region residency cannot be met without a store-by-store DO migration; a hint on new stores is a small follow-up, jurisdiction is not retrofittable.

Not implemented in code on purpose: both changes are either irreversible (jurisdiction) or need a live-QA of DO placement (locationHint).
