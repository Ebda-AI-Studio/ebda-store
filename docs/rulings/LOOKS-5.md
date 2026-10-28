# LOOKS-5

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-5 — the four template enum values (qamar, souq, jasmine, lamma) are NOT added to `TemplateId` in Phase S. Evidence: `TemplateId` drives five exhaustive `Record<TemplateId, ...>` maps (serverTemplate, pack-styles, baselines, TEMPLATE_THEMES, templates/index); adding ids before their skins exist forces placeholder entries. Each id is added in Phase B with its skin; `LookDefinition.skin` carries the rendering skin meanwhile. Cost if wrong: none for Phase S.
