# DAHAB-1

> Section: 2026-10-07 — Dahab template, builder Phase 3 pilot (branch `feat/template-dahab`)

Ruling DAHAB-1 — Dahab is its own component skin (`TemplateId` / `StoreTemplate` value `dahab`, additive migration `20261008000000_store_template_dahab`) plus the `dahab` family preset, not a theme on an existing skin. Evidence: the header, card, product page, cart lines and footer differ in structure, not only colour; an enum value changes no existing row. Cost if wrong: one more pack for the platform rules "card UX → every render path" and "header/footer → every theme" (now 6 packs).
