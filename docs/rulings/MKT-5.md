# MKT-5

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling MKT-5 — the hero is one `HeroPhone` cycling the first look of each template (static Qamar A first frame rendered by the server; fragments fetched at idle; cycle <= every 4s; paused on hover/focus and by a visible pause button; never cycles under reduced motion; the phone is `inert`/`aria-hidden`, the interactive version is the looks section). Ids inside the copy are renamed `ph-*` -> `hp-*` so the page keeps unique ids. Evidence: `tests/unit/marketing-hero-phone.test.tsx`. Cost if wrong: ~140 KB of extra fragment fetches at idle on every home load; drop the idle prefetch and fetch on the first tick if mobile Lighthouse regresses.
