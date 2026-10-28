# LOOKS-3

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-3 — switching look keeps content always; design overrides are kept unless the merchant chooses "reset". Evidence: TPL-1 ("switching keeps content; a switch asks before discarding design overrides"); `tests/integration/store-look.test.ts` (keep vs reset). Cost if wrong: a merchant who expected a clean switch sees their old colours; the dialog default and copy make the choice explicit.
