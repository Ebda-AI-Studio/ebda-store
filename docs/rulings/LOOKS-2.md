# LOOKS-2

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-2 — the look id is a Store column `stores.look` (nullable TEXT), not a StoreTheme key. Evidence: StoreTheme is an untyped, shallow-merged JSON written by four surfaces (Branding, Smart Palette, builder publish, legacy PUT), so a key there can be clobbered by any of them, and the resolver needs the look BEFORE it merges the theme; the API also reads the look (onboarding, demo gating, publish), which is the exception CLAUDE.md UI rule 3 allows. Cost if wrong: one extra column to migrate away from.
