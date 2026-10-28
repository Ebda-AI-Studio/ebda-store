# LOOKS-17

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-17 — the one sanctioned exception to "legacy stores render byte-identical" (R1): the collapsed mobile menu in the classic, elegant and minimal headers now renders `inert=""` for every store, look or not. Under React 19 (what the storefront runs) the previous `inert` value was dropped, so the hidden menu stayed in the tab order and the accessibility tree — a real WCAG 2.4.3 defect on every store. Evidence: the Phase S browser check; `tests/unit/web-inert-boolean.test.ts` pins the attribute. Cost if wrong: an HTML snapshot elsewhere that pins the old header markup needs updating.
