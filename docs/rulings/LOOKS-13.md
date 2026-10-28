# LOOKS-13

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-13 — the `storedemo` seed ships in Phase S without R2 photos and with a hand-written catalogue. Evidence: nothing is visible on `storedemo` until Phase B flips a template's looks to `built`; real photos and the generator catalogue are added then (`scripts/storedemo/seed.mjs`, `docs/ebda/templates/demo-store.md`). Cost if wrong: none (the store is not live).
