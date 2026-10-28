# B2B-7b

> Section: B2B wholesale pricing (feat/b2b-wholesale, 2026-10-21)

Ruling B2B-7b - Public catalogue routes are always computed as anonymous. They never read identity, never include group prices, always exclude `wholesale_only`; buyer-specific data comes only from authenticated `no-store` routes (`/public/pricing/resolve` plus a wholesale catalogue route). Cost if wrong: an approved buyer's wholesale-only catalogue needs one extra authenticated call.
